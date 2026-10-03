// Builds what the router and the LLM know for one turn, from the database as the user.
// Nothing here comes from the browser except the page name.
import { currentPeriod, listEmployees, listPeriods, listRuns, payTypeOn, peopleRefs, pendingApprovals } from './queries';
import type { AgentContext, ToolCtx } from './types';
import { dayLabel, monthLabel } from './tools/common';

export async function buildContext(ctx: ToolCtx, page?: string): Promise<AgentContext> {
  const periods = await listPeriods(ctx.db);
  const isApprover = ctx.me.role !== 'employee';
  const [payType, pending, people, runs] = await Promise.all([
    payTypeOn(ctx.db, ctx.me.id, ctx.today),
    isApprover ? pendingApprovals(ctx.db, ctx.me, periods) : Promise.resolve([]),
    ctx.me.role === 'admin' ? listEmployees(ctx.db).then(peopleRefs) : Promise.resolve([]),
    ctx.me.role === 'admin' ? listRuns(ctx.db) : Promise.resolve([]),
  ]);
  return { me: ctx.me, today: ctx.today, page, payType, periods, current: currentPeriod(periods, ctx.today), pending, people, runs };
}

/** A short plain-text picture of the user's situation, shared by the decider and the LLM. */
export function describeContext(c: AgentContext): string {
  const lines = [
    `User: ${c.me.first_name} ${c.me.last_name} (${c.me.role}${c.payType ? `, paid ${c.payType === 'daily' ? 'by the day' : c.payType}` : ''}).`,
    `Today: ${dayLabel(c.today)} (${c.today}).`,
    c.current ? `Current pay period: ${monthLabel(c.current.start_date)} (${c.current.status}).` : 'No pay period is open.',
  ];
  if (c.page) lines.push(`They are looking at the ${c.page} page.`);
  if (c.pending.length) lines.push(`Waiting for their approval: ${c.pending.map((p) => p.name).join(', ')}.`);
  return lines.join('\n');
}
