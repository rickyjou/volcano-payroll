// Saved conversations and agent actions, both private to their user through RLS.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { asJson, num, rows } from '../server/db';
import type { Card, ChatMessage, Confirmation } from './types';

export const HISTORY_DAYS = 30;
/** How long a confirmation card stays usable. */
export const CONFIRM_TTL_MS = 10 * 60_000;
const HISTORY_LIMIT = 50;

export interface MessageMeta { path?: 'decider' | 'llm' | 'ask' | 'action' | 'error'; confidence?: number | null; latencyMs?: number }

export interface ActionRow {
  id: string;
  user_id: string;
  tool: string;
  args: Record<string, unknown>;
  confirmation: Confirmation | null;
  status: 'pending' | 'done' | 'cancelled' | 'expired' | 'undone' | 'failed';
  undo: unknown;
  expires_at: string;
}

/** Secrets and file bodies are shown once in the reply but never written to history. */
export function storableCards(cards: Card[]): Card[] {
  return cards.map((c) => {
    if (c.kind === 'secret') return { ...c, value: '' };
    if (c.kind === 'download') return { ...c, body: '' };
    return c;
  });
}

export async function saveMessage(db: VolcanoAuth, userId: string, role: 'user' | 'assistant', content: string, cards: Card[] = [], meta: MessageMeta = {}): Promise<ChatMessage> {
  const [row] = await rows<ChatMessage>(db.insert('chat_messages', {
    user_id: userId,
    role,
    content,
    cards: asJson(storableCards(cards)),
    path: meta.path ?? null,
    confidence: meta.confidence == null ? null : Math.round(meta.confidence * 1000) / 1000,
    latency_ms: meta.latencyMs ?? null,
  }));
  // Return what the user should see now, including the one-time values.
  return { id: row.id, role, content, cards, created_at: row.created_at };
}

/** The latest messages, oldest first, after deleting ones past the retention window. */
export async function history(db: VolcanoAuth, userId: string, now: Date): Promise<ChatMessage[]> {
  const cutoff = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  await rows(db.delete('chat_messages').eq('user_id', userId).lt('created_at', cutoff));
  const out = await rows<ChatMessage>(db.from('chat_messages').select('id,role,content,cards,created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(HISTORY_LIMIT));
  return out.reverse().map((m) => ({ ...m, cards: Array.isArray(m.cards) ? m.cards : [] }));
}

/** The last few turns as plain text, for the LLM. */
export async function recentTurns(db: VolcanoAuth, userId: string, limit = 6): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const out = await rows<{ role: 'user' | 'assistant'; content: string }>(db.from('chat_messages').select('role,content')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit));
  return out.reverse().filter((m) => m.content.trim() !== '');
}

export async function createAction(
  db: VolcanoAuth, userId: string,
  a: { tool: string; args: Record<string, unknown>; confirmation?: Confirmation | null; status: ActionRow['status']; undo?: unknown; expiresAt: Date },
): Promise<ActionRow> {
  const [row] = await rows<ActionRow>(db.insert('agent_actions', {
    user_id: userId,
    tool: a.tool,
    args: asJson(a.args),
    confirmation: a.confirmation ? asJson(a.confirmation) : null,
    status: a.status,
    undo: a.undo === undefined ? null : asJson(a.undo),
    expires_at: a.expiresAt.toISOString(),
  }));
  return row;
}

export async function getAction(db: VolcanoAuth, userId: string, id: string): Promise<ActionRow | null> {
  const [row] = await rows<ActionRow>(db.from('agent_actions').select('id,user_id,tool,args,confirmation,status,undo,expires_at')
    .eq('id', id).eq('user_id', userId).limit(1));
  return row ?? null;
}

/** The newest pending action that has not expired. */
export async function latestPending(db: VolcanoAuth, userId: string, now: Date): Promise<ActionRow | null> {
  const [row] = await rows<ActionRow>(db.from('agent_actions').select('id,user_id,tool,args,confirmation,status,undo,expires_at')
    .eq('user_id', userId).eq('status', 'pending').gt('expires_at', now.toISOString())
    .order('created_at', { ascending: false }).limit(1));
  return row ?? null;
}

/**
 * Moves an action from one status to another. Returns false when it was no longer in
 * `from` (a second click, or another tab got there first), so the caller does nothing.
 */
export async function moveAction(db: VolcanoAuth, userId: string, id: string, from: ActionRow['status'], to: ActionRow['status'], undo?: unknown): Promise<boolean> {
  const values: Record<string, string | null> = { status: to, updated_at: new Date().toISOString() };
  if (undo !== undefined) values.undo = undo === null ? null : asJson(undo);
  const out = await rows(db.update('agent_actions', values).eq('id', id).eq('user_id', userId).eq('status', from));
  return out.length > 0;
}

export const confidenceOf = (v: unknown): number | null => num(v);
