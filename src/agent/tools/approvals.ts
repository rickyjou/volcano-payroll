// Manager tools (admins can use them for everyone): see what's waiting, inspect a
// timesheet, and approve or return timesheets. RLS limits managers to direct reports.
import { rows } from '../../server/db';
import { HttpError } from '../../server/http';
import {
  entriesFor, fullName, getEmployee, getPeriod, getTimesheet, listEmployees, listPeriods, pendingApprovals,
} from '../queries';
import { Refusal, type AgentTool, type RowAction, type ToolCtx } from '../types';
import { amountLabel, dayLabel, monthLabel, periodArg } from './common';

const APPROVERS = ['manager', 'admin'] as const;

async function totalsBySheet(ctx: ToolCtx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const entries = await rows<{ timesheet_id: string; hours: unknown; days: unknown }>(ctx.db.from('time_entries')
    .select('timesheet_id,hours,days').in('timesheet_id', ids).limit(10_000));
  const sum = new Map<string, { hours: number; days: number }>();
  for (const e of entries) {
    const t = sum.get(e.timesheet_id) ?? { hours: 0, days: 0 };
    sum.set(e.timesheet_id, { hours: t.hours + Number(e.hours ?? 0), days: t.days + Number(e.days ?? 0) });
  }
  return new Map([...sum].map(([id, t]) => [id, [t.hours ? amountLabel({ hours: t.hours }) : '', t.days ? amountLabel({ days: t.days }) : ''].filter(Boolean).join(' + ') || '0h']));
}

type SheetName = { name: string; month: string; status: string };

async function sheetName(ctx: ToolCtx, id: string): Promise<SheetName> {
  const s = await getTimesheet(ctx.db, id);
  const [e, p] = await Promise.all([getEmployee(ctx.db, s.employee_id), getPeriod(ctx.db, s.pay_period_id)]);
  return { name: fullName(e), month: monthLabel(p.start_date), status: s.status };
}

const notWaiting = (n: SheetName) => `${n.name}'s ${n.month} timesheet is ${n.status}, not waiting for approval`;

/** The statuses a timesheet may be approved from: submitted, or (admins) a leaver's unsubmitted one. */
const approvableFrom = (leaver: boolean) => (leaver ? ['submitted', 'draft', 'rejected'] : ['submitted']);

/**
 * Moves a timesheet only if it is still in one of `from` (the card may be stale: another tab
 * or the Approvals screen can have acted since). Refuses with its current status otherwise.
 */
async function moveSheet(ctx: ToolCtx, id: string, from: string[], patch: { status: string; rejection_note?: string }): Promise<SheetName> {
  const who = await sheetName(ctx, id);
  if (from.includes(who.status)) {
    const moved = await rows(ctx.db.update('timesheets', patch).eq('id', id).in('status', from));
    if (moved.length) return who;
  }
  throw new Refusal(notWaiting(await sheetName(ctx, id)));
}

/** The timesheets (of those given) whose employee has left. */
async function leaverSheets(ctx: ToolCtx, ids: string[]): Promise<Set<string>> {
  const sheets = await rows<{ id: string; employee_id: string }>(ctx.db.from('timesheets').select('id,employee_id').in('id', ids));
  const left = new Set((await listEmployees(ctx.db)).filter((e) => e.status === 'terminated').map((e) => e.id));
  return new Set(sheets.filter((s) => left.has(s.employee_id)).map((s) => s.id));
}

export const listPendingApprovals: AgentTool = {
  name: 'list_pending_approvals',
  roles: [...APPROVERS],
  description: 'list the timesheets waiting for my approval',
  kind: 'read',
  args: { period: { type: 'uuid', slot: 'period', description: 'Only this pay period (default: all open ones)' } },
  async run(ctx, a) {
    const periods = await listPeriods(ctx.db);
    const pending = (await pendingApprovals(ctx.db, ctx.me, periods)).filter((p) => !a.period || p.period_id === a.period);
    if (pending.length === 0) return { text: 'Nothing is waiting for your approval.', data: { pending: [] } };
    const month = new Map(periods.map((p) => [p.id, monthLabel(p.start_date)]));
    const totals = await totalsBySheet(ctx, pending.map((p) => p.id));
    const actions: RowAction[][] = pending.map((p) => [
      { label: p.status === 'submitted' ? 'Approve' : 'Approve (has left)', request: { tool: 'approve_timesheets', args: { timesheets: [p.id] } } },
      ...(p.status === 'submitted' ? [{ label: 'Return', request: { tool: 'return_timesheet', args: { timesheet: p.id } }, needsNote: true }] : []),
    ]);
    return {
      text: `${pending.length} timesheet${pending.length === 1 ? '' : 's'} waiting for you.`,
      cards: [{
        kind: 'table', title: 'Waiting for approval', columns: ['Employee', 'Month', 'Status', 'Total'],
        rows: pending.map((p) => [p.name, month.get(p.period_id) ?? '', p.status, totals.get(p.id) ?? '0h']),
        rowActions: actions,
      }],
      data: { pending: pending.map((p) => ({ timesheet: p.id, name: p.name, month: month.get(p.period_id), status: p.status, total: totals.get(p.id) })) },
    };
  },
};

export const showEmployeeTimesheet: AgentTool = {
  name: 'show_employee_timesheet',
  roles: [...APPROVERS],
  description: "show the days and totals on one employee's timesheet",
  kind: 'read',
  args: { timesheet: { type: 'uuid', required: true, slot: 'timesheet', description: 'The timesheet' } },
  async run(ctx, a) {
    const who = await sheetName(ctx, a.timesheet as string);
    const entries = await entriesFor(ctx.db, a.timesheet as string);
    const total = (await totalsBySheet(ctx, [a.timesheet as string])).get(a.timesheet as string) ?? '0h';
    return {
      text: `${who.name}, ${who.month}: ${who.status}, total ${total}.`,
      cards: [{ kind: 'table', title: `${who.name} — ${who.month}`, columns: ['Day', 'Code', 'Amount'], rows: entries.map((e) => [dayLabel(e.work_date), e.earning_code, amountLabel(e)]) }],
      data: { ...who, total, entries: entries.map((e) => ({ day: e.work_date, code: e.earning_code, hours: e.hours, days: e.days })) },
    };
  },
};

export const teamStatus: AgentTool = {
  name: 'team_status',
  roles: [...APPROVERS],
  description: "show who on my team has submitted, is still working on, or hasn't started a month's timesheet",
  kind: 'read',
  args: { period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the current one)' } },
  async run(ctx, a) {
    const period = await periodArg(ctx, a.period);
    const team = (await listEmployees(ctx.db)).filter((e) => e.status === 'active' && e.id !== ctx.me.id && (ctx.me.role === 'admin' || e.manager_id === ctx.me.id));
    const sheets = await rows<{ employee_id: string; status: string }>(ctx.db.from('timesheets').select('employee_id,status').eq('pay_period_id', period.id).limit(5000));
    const status = new Map(sheets.map((s) => [s.employee_id, s.status]));
    const table = team.map((e) => [fullName(e), status.get(e.id) ?? 'not started']);
    const count = (s: string) => table.filter((r) => r[1] === s).length;
    return {
      text: `${monthLabel(period.start_date)}: ${count('approved')} approved, ${count('submitted')} submitted, ${count('draft') + count('rejected')} in progress, ${count('not started')} not started.`,
      cards: [{ kind: 'table', title: `Team — ${monthLabel(period.start_date)}`, columns: ['Employee', 'Timesheet'], rows: table }],
      data: { month: monthLabel(period.start_date), team: table.map(([name, s]) => ({ name, status: s })) },
    };
  },
};

export const approveTimesheets: AgentTool = {
  name: 'approve_timesheets',
  roles: [...APPROVERS],
  description: 'approve one or more submitted timesheets (admins: also the unsubmitted timesheet of someone who has left)',
  kind: 'write',
  args: { timesheets: { type: 'uuids', required: true, slot: 'timesheets', description: 'The timesheets to approve' } },
  async confirm(ctx, a) {
    const ids = a.timesheets as string[];
    const names = await Promise.all(ids.map((id) => sheetName(ctx, id)));
    // Only submitted timesheets (or, for admins, a leaver's unsubmitted one) can be approved.
    const leaving = ctx.me.role === 'admin' ? await leaverSheets(ctx, ids) : new Set<string>();
    const stale = names.filter((n, i) => !approvableFrom(leaving.has(ids[i])).includes(n.status));
    if (stale.length) {
      throw new Refusal(`Nothing to approve: ${stale.map((n) => `${n.name}'s ${n.month} timesheet is ${n.status}`).join('; ')}, not waiting for approval.`);
    }
    return {
      title: `Approve ${ids.length} timesheet${ids.length === 1 ? '' : 's'}?`,
      lines: names.map((n) => `${n.name} — ${n.month} (${n.status})`),
      choices: [{ id: 'confirm', label: 'Approve', style: 'primary' }, { id: 'cancel', label: 'Cancel', style: 'secondary' }],
    };
  },
  async run(ctx, a) {
    const ids = a.timesheets as string[];
    const leaving = ctx.me.role === 'admin' ? await leaverSheets(ctx, ids) : new Set<string>();
    const done: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const who = await moveSheet(ctx, id, approvableFrom(leaving.has(id)), { status: 'approved' });
        done.push(`${who.name} (${who.month})`);
      } catch (err) {
        if (err instanceof Refusal) failed.push(err.message);
        else failed.push(`${(await sheetName(ctx, id).catch(() => null))?.name ?? 'A timesheet'}: ${err instanceof HttpError ? err.message : 'could not be approved'}`);
      }
    }
    if (done.length === 0) throw new Refusal(`Nothing was approved. ${failed.join('; ')}.`);
    return {
      text: `Approved ${done.join(', ')}.${failed.length ? ` Not approved: ${failed.join('; ')}.` : ''}`,
      changed: ['timesheets'],
      data: { approved: done, failed },
    };
  },
};

export const returnTimesheet: AgentTool = {
  name: 'return_timesheet',
  roles: [...APPROVERS],
  description: 'send a submitted timesheet back to the employee with a note saying what to fix',
  kind: 'write',
  args: {
    timesheet: { type: 'uuid', required: true, slot: 'timesheet', description: 'The timesheet' },
    note: { type: 'string', required: true, slot: 'note', description: 'What the employee should fix' },
  },
  async confirm(ctx, a) {
    const who = await sheetName(ctx, a.timesheet as string);
    if (who.status !== 'submitted') throw new Refusal(`${notWaiting(who)}.`);
    return { title: `Return ${who.name}'s ${who.month} timesheet?`, lines: [`Note: "${a.note}"`], choices: [{ id: 'confirm', label: 'Return', style: 'primary' }, { id: 'cancel', label: 'Cancel', style: 'secondary' }] };
  },
  async run(ctx, a) {
    const who = await moveSheet(ctx, a.timesheet as string, ['submitted'], { status: 'rejected', rejection_note: a.note as string }).catch((err) => {
      throw err instanceof Refusal ? new Refusal(`${err.message}.`) : err;
    });
    return { text: `Returned ${who.name}'s ${who.month} timesheet with your note.`, changed: ['timesheets'] };
  },
};

export const APPROVAL_TOOLS = [listPendingApprovals, showEmployeeTimesheet, teamStatus, approveTimesheets, returnTimesheet];
