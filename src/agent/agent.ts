// One chat turn, end to end: route the message, run the tool (or ask, or hand over to the
// LLM), store the confirmation or Undo, and save both sides of the conversation.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { fromUtc } from '../lib/dates';
import { HttpError } from '../server/http';
import { toJsonSchema, validateArgs } from './args';
import { buildContext, describeContext } from './context';
import type { Decider } from './decider';
import { invoker } from './invoke';
import type { Llm, LlmMessage } from './llm';
import { DEFAULT_THRESHOLD, deciderQuestions, deciderState, route, type Answers } from './router';
import {
  CONFIRM_TTL_MS, createAction, getAction, history, latestPending, moveAction, recentTurns, saveMessage, type MessageMeta,
} from './store';
import { CONFIRM_CHOICES, monthLabel, periodArg, sentence } from './tools/common';
import { toolByName, toolsFor } from './tools';
import { Refusal, type AgentContext, type AgentTool, type AgentUser, type Card, type ChatMessage, type ToolCtx } from './types';

export interface AgentDeps {
  db: VolcanoAuth;
  /** The Volcano auth user id (owner of chat rows). */
  userId: string;
  me: AgentUser;
  now: Date;
  /** The user's local date when the caller knows it (see server.ts clientToday); else UTC. */
  today?: string;
  decider: Decider | null;
  llm: Llm | null;
  threshold?: number;
  /** Defaults to calling Functions with the user's own client. */
  invoke?: ToolCtx['invoke'];
}

export type AgentRequest =
  | { type: 'history' }
  | { type: 'message'; text: string; page?: string }
  | { type: 'action'; actionId: string; choice: string; label?: string }
  | { type: 'tool'; tool: string; args: Record<string, unknown>; label?: string };

export interface AgentResponse {
  messages: ChatMessage[];
  changed: string[];
}

interface Outcome {
  text: string;
  cards: Card[];
  changed: string[];
  meta: MessageMeta;
  /** For the LLM loop: facts to hand back, and whether the turn must stop here. */
  data?: unknown;
  stop?: boolean;
}

export const MAX_MESSAGE = 2000;
const TURN_BUDGET_MS = 25_000;
const LLM_ROUNDS = 4;
const LLM_TIMEOUT_MS = 20_000;

const HELP: Record<AgentUser['role'], string[]> = {
  employee: ['Log 8 hours for today', 'Log a half day of PTO on Friday', 'Show my timesheet', 'Submit my timesheet', 'What was my pay last month?'],
  manager: ['What needs my approval?', "Approve Hal's timesheet", 'Who on my team hasn\'t submitted?', 'Log 8 hours for today'],
  admin: ['Open next month', 'Lock October', "Generate October's run", 'Finalize the run', 'Export October for Gusto', 'Add an employee'],
};

export async function handleAgentRequest(deps: AgentDeps, req: AgentRequest): Promise<AgentResponse> {
  const ctx: ToolCtx = { db: deps.db, me: deps.me, today: deps.today ?? fromUtc(deps.now.getTime()), invoke: deps.invoke ?? invoker(deps.db) };
  if (req.type === 'history') return { messages: await history(deps.db, deps.userId, deps.now), changed: [] };

  const started = Date.now();
  let userText: string;
  let outcome: Outcome;
  if (req.type === 'message') {
    userText = req.text.trim().slice(0, MAX_MESSAGE);
    if (!userText) return { messages: [], changed: [] };
    const saved = await saveMessage(deps.db, deps.userId, 'user', userText);
    outcome = await message(deps, ctx, userText, started, req.page);
    return finish(deps, [saved], outcome, started);
  }
  if (req.type === 'action') {
    userText = req.label ?? req.choice;
    const saved = await saveMessage(deps.db, deps.userId, 'user', userText);
    outcome = await action(deps, ctx, req.actionId, req.choice);
    return finish(deps, [saved], outcome, started);
  }
  const tool = toolByName(req.tool);
  const saved = await saveMessage(deps.db, deps.userId, 'user', req.label ?? req.tool);
  outcome = tool ? await execute(deps, ctx, tool, req.args, 'action') : reply("I don't know how to do that.", 'error');
  return finish(deps, [saved], outcome, started);
}

async function finish(deps: AgentDeps, before: ChatMessage[], o: Outcome, started: number): Promise<AgentResponse> {
  const saved = await saveMessage(deps.db, deps.userId, 'assistant', o.text, o.cards, { ...o.meta, latencyMs: Date.now() - started });
  return { messages: [...before, saved], changed: [...new Set(o.changed)] };
}

const expiry = (deps: AgentDeps) => new Date(deps.now.getTime() + CONFIRM_TTL_MS);

const reply = (text: string, path: MessageMeta['path'], extra: Partial<Outcome> = {}): Outcome =>
  ({ text, cards: [], changed: [], meta: { path }, ...extra });

async function message(deps: AgentDeps, ctx: ToolCtx, text: string, started: number, page?: string): Promise<Outcome> {
  const context = await buildContext(ctx, page);
  const tools = toolsFor(deps.me.role);
  const pending = await latestPending(deps.db, deps.userId, deps.now);
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;

  let answers: Answers | null = null;
  if (deps.decider) {
    try {
      answers = await deps.decider.decide(deciderState(describeContext(context), text), deciderQuestions(context, tools, !!pending));
    } catch (err) {
      console.warn('decider unavailable, using the LLM', err);
    }
  }
  const r = route({ text, context, tools, answers, threshold, hasPending: !!pending });
  const meta: MessageMeta = { path: 'decider', confidence: r.confidence };

  switch (r.kind) {
    case 'tool':
      return { ...(await execute(deps, ctx, r.tool, r.args, 'decider')), meta };
    case 'ask':
      return { text: r.text, cards: [r.card], changed: [], meta: { path: 'ask', confidence: r.confidence } };
    case 'help':
      return { text: `Here are some things you can ask me:\n${HELP[deps.me.role].map((h) => `• ${h}`).join('\n')}`, cards: [], changed: [], meta };
    case 'confirm':
    case 'cancel': {
      const choices = (pending!.confirmation?.choices ?? CONFIRM_CHOICES).filter((c) => c.id !== 'cancel');
      if (r.kind === 'cancel') return { ...(await action(deps, ctx, pending!.id, 'cancel')), meta };
      if (choices.length !== 1) return { text: 'Please pick one of the options on the card above.', cards: [], changed: [], meta };
      return { ...(await action(deps, ctx, pending!.id, choices[0].id)), meta };
    }
    case 'llm':
      return { ...(await llmTurn(deps, ctx, context, tools, started)), meta: { path: 'llm', confidence: r.confidence } };
  }
}

/** Runs a tool with its tier rules. `via` says who chose it (for the LLM loop). */
async function execute(deps: AgentDeps, ctx: ToolCtx, tool: AgentTool, rawArgs: unknown, via: 'decider' | 'llm' | 'action'): Promise<Outcome> {
  const meta: MessageMeta = { path: via === 'action' ? 'action' : via };
  if (!tool.roles.includes(deps.me.role)) return reply("You don't have access to that.", 'error', { stop: false });
  const v = validateArgs(tool.args, (rawArgs ?? {}) as Record<string, unknown>);
  if (!v.ok) return reply(`I couldn't do that: ${v.error}.`, 'error', { data: { error: v.error } });
  try {
    if (tool.kind === 'read') {
      const r = await tool.run(ctx, v.args);
      return { text: r.text, cards: r.cards ?? [], changed: r.changed ?? [], meta, data: r.data ?? r.text };
    }
    // Store the month the card names, not "whichever is current when the user clicks".
    if (tool.args.period?.slot === 'period' && v.args.period === undefined) v.args.period = (await periodArg(ctx, undefined)).id;
    const confirmation = tool.confirm ? await tool.confirm(ctx, v.args) : { title: `Run ${tool.name}?`, lines: [] };
    if (confirmation) {
      const choices = confirmation.choices ?? CONFIRM_CHOICES;
      const saved = await createAction(deps.db, deps.userId, { tool: tool.name, args: v.args, confirmation: { ...confirmation, choices }, status: 'pending', expiresAt: expiry(deps) });
      return {
        // The card carries the question; repeating it as text would show it twice.
        text: '',
        cards: [{ kind: 'confirm', actionId: saved.id, title: confirmation.title, lines: confirmation.lines, choices }],
        changed: [], meta, stop: true,
      };
    }
    const r = await tool.run(ctx, v.args);
    const cards = [...(r.cards ?? [])];
    if (r.undo !== undefined && tool.undo) {
      const saved = await createAction(deps.db, deps.userId, { tool: tool.name, args: v.args, status: 'done', undo: r.undo, expiresAt: expiry(deps) });
      cards.push({ kind: 'undo', actionId: saved.id, label: 'Undo' });
    }
    return { text: r.text, cards, changed: r.changed ?? [], meta, data: r.data ?? r.text, stop: true };
  } catch (err) {
    return refusal(err, meta);
  }
}

function refusal(err: unknown, meta: MessageMeta): Outcome {
  if (err instanceof Refusal) return { text: err.message, cards: err.cards, changed: [], meta, data: { refused: err.message } };
  if (err instanceof HttpError) return { text: sentence(err.message), cards: [], changed: [], meta, data: { refused: err.message } };
  console.error('agent tool failed', err);
  return { text: 'Something went wrong doing that. Please try again, or use the screens.', cards: [], changed: [], meta: { path: 'error' } };
}

/** Confirm / cancel / undo a stored action. Only the owner's actions are found. */
async function action(deps: AgentDeps, ctx: ToolCtx, actionId: string, choice: string): Promise<Outcome> {
  const meta: MessageMeta = { path: 'action' };
  const a = await getAction(deps.db, deps.userId, actionId);
  const tool = a ? toolByName(a.tool) : undefined;
  if (!a || !tool) return reply("That action isn't available any more.", 'action');
  // The row is the user's own (RLS lets them edit it), so check it like a fresh request.
  if (!tool.roles.includes(deps.me.role)) return reply("You don't have access to that.", 'action');

  if (choice === 'undo') {
    if (a.status !== 'done' || a.undo == null || !tool.undo) return reply("That can't be undone any more.", 'action');
    if (!(await moveAction(deps.db, deps.userId, a.id, 'done', 'undone'))) return reply('That was already undone.', 'action');
    try {
      const r = await tool.undo(ctx, a.undo);
      return { text: r.text, cards: [], changed: r.changed ?? [], meta };
    } catch (err) {
      await moveAction(deps.db, deps.userId, a.id, 'undone', 'done');
      return refusal(err, meta);
    }
  }
  if (a.status !== 'pending') return reply(`That was already ${a.status === 'done' ? 'done' : a.status}.`, 'action');
  if (new Date(a.expires_at).getTime() <= deps.now.getTime()) {
    await moveAction(deps.db, deps.userId, a.id, 'pending', 'expired');
    return reply('That confirmation expired. Please ask again.', 'action');
  }
  if (choice === 'cancel') {
    await moveAction(deps.db, deps.userId, a.id, 'pending', 'cancelled');
    return reply('Cancelled. Nothing was changed.', 'action');
  }
  if (!(a.confirmation?.choices ?? CONFIRM_CHOICES).some((c) => c.id === choice)) return reply("That isn't one of the options.", 'action');
  const v = validateArgs(tool.args, a.args);
  if (!v.ok) {
    await moveAction(deps.db, deps.userId, a.id, 'pending', 'failed');
    return reply(`I couldn't do that: ${v.error}.`, 'action');
  }
  if (!(await moveAction(deps.db, deps.userId, a.id, 'pending', 'done'))) return reply('That was already handled.', 'action');
  try {
    const r = await tool.run(ctx, v.args, choice);
    const cards = [...(r.cards ?? [])];
    if (r.undo !== undefined && tool.undo) {
      await moveAction(deps.db, deps.userId, a.id, 'done', 'done', r.undo);
      cards.push({ kind: 'undo', actionId: a.id, label: 'Undo' });
    }
    return { text: r.text, cards, changed: r.changed ?? [], meta };
  } catch (err) {
    await moveAction(deps.db, deps.userId, a.id, 'done', 'failed');
    return refusal(err, meta);
  }
}

function systemPrompt(c: AgentContext): string {
  const ids = [
    c.periods.length ? `Pay periods: ${c.periods.map((p) => `${monthLabel(p.start_date)} (${p.status}) id=${p.id}`).join('; ')}` : '',
    c.pending.length ? `Timesheets waiting for approval: ${c.pending.map((p) => `${p.name} (${p.status}) id=${p.id}`).join('; ')}` : '',
    c.people.length ? `Employees: ${c.people.slice(0, 100).map((p) => `${p.name} <${p.email}> id=${p.id}`).join('; ')}` : '',
    c.runs.length ? `Payroll runs: ${c.runs.map((r) => `${c.periods.find((p) => p.id === r.period_id)?.start_date.slice(0, 7) ?? '?'} (${r.status}) id=${r.id}`).join('; ')}` : '',
  ].filter(Boolean);
  return [
    'You are the payroll assistant inside a time-tracking and payroll app. You act only by calling the tools, and only as this user.',
    describeContext(c),
    ...ids,
    'Rules: use only ids listed here or returned by tools; never invent them. Dates are YYYY-MM-DD. If a detail is missing, ask one short question.',
    'Changes are confirmed by the user on a card, so call the tool rather than asking "are you sure". Pay is gross pay; the payroll provider handles taxes.',
    'Keep replies short and plain.',
  ].join('\n');
}

async function llmTurn(deps: AgentDeps, ctx: ToolCtx, context: AgentContext, tools: AgentTool[], started: number): Promise<Outcome> {
  if (!deps.llm) {
    return reply(`I can only handle simple requests right now, such as:\n${HELP[deps.me.role].map((h) => `• ${h}`).join('\n')}`, 'llm');
  }
  // The budget covers the whole turn (context, decider, LLM), so count from its start.
  const deadline = started + TURN_BUDGET_MS;
  const turns = await recentTurns(deps.db, deps.userId, 7);
  const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt(context) }, ...turns];
  const llmTools = tools.map((t) => ({ name: t.name, description: t.description, parameters: toJsonSchema(t.args) }));
  const cards: Card[] = [];
  const changed: string[] = [];
  try {
    for (let round = 0; round < LLM_ROUNDS && Date.now() < deadline; round++) {
      const res = await deps.llm.complete({ messages, tools: llmTools, timeoutMs: Math.min(LLM_TIMEOUT_MS, deadline - Date.now()) });
      if (res.toolCalls.length === 0) return { text: res.text || 'Done.', cards, changed, meta: { path: 'llm' } };
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        const out = tool
          ? await execute(deps, ctx, tool, call.args, 'llm')
          : reply(`There is no tool called ${call.name}.`, 'error', { data: { error: `unknown tool ${call.name}` } });
        cards.push(...out.cards);
        changed.push(...out.changed);
        if (out.stop) return { text: [res.text, out.text].filter(Boolean).join('\n'), cards, changed, meta: { path: 'llm' } };
        messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(out.data ?? out.text) });
      }
    }
    return { text: "I couldn't finish that. Please try rephrasing or breaking it into smaller steps.", cards, changed, meta: { path: 'llm' } };
  } catch (err) {
    console.error('LLM unavailable', err);
    return reply(`I can't handle that right now. Try a simpler request, such as:\n${HELP[deps.me.role].map((h) => `• ${h}`).join('\n')}`, 'error');
  }
}
