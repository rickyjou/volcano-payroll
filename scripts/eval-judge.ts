// Judges one routed evaluation case against its label (used by eval-decider.ts).
// A write error is any wrong route where a write could happen: a write-labelled message
// sent elsewhere, or any message sent INTO a write (a write tool, a typed "yes", or a
// question card whose buttons run a write tool).
import type { Route } from '../src/agent/router';
import { toolByName } from '../src/agent/tools';
import type { Role } from '../src/agent/types';

export interface Case { role: Role; text: string; intent: string; args?: Record<string, unknown> }
export type Verdict = 'correct' | 'wrong' | 'llm';

export const isWrite = (intent: string) => intent === 'confirm' || toolByName(intent)?.kind === 'write';

function routesToWrite(r: Route): boolean {
  if (r.kind === 'tool') return r.tool.kind === 'write';
  if (r.kind === 'confirm') return true;
  if (r.kind === 'ask' && r.card.kind === 'choices') return r.card.options.some((o) => isWrite(o.request.tool));
  return false;
}

function verdictOf(c: Case, r: Route): Verdict {
  if (r.kind === 'llm') return 'llm';
  if (r.kind === 'ask') return r.card.kind === 'choices' && r.card.options[0]?.request.tool === c.intent ? 'correct' : 'wrong';
  if (r.kind !== 'tool') return r.kind === c.intent ? 'correct' : 'wrong';
  if (r.tool.name !== c.intent) return 'wrong';
  for (const [k, v] of Object.entries(c.args ?? {})) if (JSON.stringify(r.args[k]) !== JSON.stringify(v)) return 'wrong';
  return 'correct';
}

export function judge(c: Case, r: Route): { verdict: Verdict; writeError: boolean } {
  const verdict = verdictOf(c, r);
  return { verdict, writeError: verdict === 'wrong' && (isWrite(c.intent) || routesToWrite(r)) };
}
