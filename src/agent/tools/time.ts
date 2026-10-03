// Employee time tools: log, clear, show, submit and recall one's own timesheet, plus pay
// and profile. Hours are never overwritten silently (see planLog).
import type { ISODate } from '../../lib/dates';
import { ENTRY_CODES, type EntryCode } from '../../lib/types';
import { isoDate, num, rows, selectAll } from '../../server/db';
import {
  changed, ensureTimesheet, entriesFor, findTimesheet, getEmployee, payTypeOn, periodFor, type EntryRow, type TimesheetRow,
} from '../queries';
import { Refusal, type AgentTool, type Confirmation, type PeriodRef, type ToolCtx } from '../types';
import { amountLabel, CONFIRM_CHOICES, dayLabel, missingWeekdays, money, monthLabel, periodArg } from './common';

const EVERYONE = ['employee', 'manager', 'admin'] as const;
const CODE = { enum: ENTRY_CODES } as const;

interface LogPlan {
  period: PeriodRef;
  sheet: TimesheetRow | null;
  existing: EntryRow | null;
  next: { hours: number | null; days: number | null };
  unit: 'hours' | 'days';
}

/** Reads the day, checks it can be edited, and works out the new value. Throws Refusal. */
async function planLog(ctx: ToolCtx, a: Record<string, unknown>, mode: 'set' | 'add'): Promise<LogPlan> {
  const day = a.day as ISODate;
  const code = (a.code as EntryCode | undefined) ?? 'REG';
  const period = await periodFor(ctx.db, day);
  if (!period) throw new Refusal(`No pay period covers ${dayLabel(day)} yet. Ask your payroll admin to open ${monthLabel(day)}.`);
  if (period.status !== 'open') throw new Refusal(`${monthLabel(period.start_date)} is ${period.status}, so its time can no longer be changed.`);

  const sheet = await findTimesheet(ctx.db, ctx.me.id, period.id);
  if (sheet && !['draft', 'rejected'].includes(sheet.status)) {
    throw new Refusal(`Your ${monthLabel(period.start_date)} timesheet is ${sheet.status}. Recall it to make changes.`, sheet.status === 'submitted'
      ? [{ kind: 'choices', prompt: 'Recall it now?', options: [{ label: 'Recall to edit', request: { tool: 'recall_timesheet', args: { period: period.id } } }] }]
      : []);
  }
  const entries = sheet ? await entriesFor(ctx.db, sheet.id) : [];
  const existing = entries.find((e) => e.work_date === day && e.earning_code === code) ?? null;

  const unit = (await payTypeOn(ctx.db, ctx.me.id, day)) === 'daily' ? 'days' : 'hours';
  const amount = unit === 'days' ? (a.days as number | undefined) : (a.hours as number | undefined);
  if (amount == null) {
    throw new Refusal(unit === 'days' ? 'You are paid by the day: say "full day" or "half day".' : 'How many hours? For example "8 hours".');
  }
  const before = (unit === 'days' ? existing?.days : existing?.hours) ?? 0;
  const value = Math.round((mode === 'add' ? before + amount : amount) * 100) / 100;
  if (unit === 'days' && value !== 0.5 && value !== 1) throw new Refusal('A day can only be logged as a full day or a half day.');
  if (unit === 'hours') {
    if (value <= 0) throw new Refusal('Hours must be more than zero.');
    const otherHours = entries.filter((e) => e.work_date === day && e.earning_code !== code).reduce((s, e) => s + (e.hours ?? 0), 0);
    if (value + otherHours > 24) throw new Refusal(`${dayLabel(day)} would have ${value + otherHours}h; the most is 24h in a day.`);
  }
  return { period, sheet, existing, next: unit === 'days' ? { hours: null, days: value } : { hours: value, days: null }, unit };
}

const periodTotal = (entries: EntryRow[]) => ({
  hours: Math.round(entries.reduce((s, e) => s + (e.hours ?? 0), 0) * 100) / 100,
  days: entries.reduce((s, e) => s + (e.days ?? 0), 0),
});

export const logTime: AgentTool = {
  name: 'log_time',
  roles: [...EVERYONE],
  description: 'record hours (or days) worked or taken off on a date in my own timesheet',
  kind: 'write',
  args: {
    day: { type: 'date', required: true, slot: 'day', description: 'The day worked' },
    code: { type: CODE, slot: 'code', description: 'REG worked (default), PTO, SICK or HOL' },
    hours: { type: 'number', slot: 'amount', description: 'Hours, for hourly and salaried employees' },
    days: { type: 'number', slot: 'amount', description: '1 or 0.5, for daily-rate employees' },
    mode: { type: { enum: ['set', 'add'] }, slot: 'mode', description: 'set the day to this amount (default) or add to what is there' },
  },
  async confirm(ctx, a): Promise<Confirmation | null> {
    const mode = a.mode === 'add' ? 'add' : 'set';
    const plan = await planLog(ctx, a, mode);
    if (!plan.existing || mode === 'add') return null;
    const code = (a.code as string) ?? 'REG';
    const old = amountLabel(plan.existing);
    if (old === amountLabel(plan.next)) throw new Refusal(`${dayLabel(a.day as string)} already has ${old} ${code}. Nothing to change.`);
    const added = await planLog(ctx, a, 'add').then((p) => amountLabel(p.next)).catch(() => null);
    return {
      title: `${dayLabel(a.day as string)} already has ${old} ${code}`,
      lines: [`You asked to log ${amountLabel(plan.next)}.`],
      choices: [
        { id: 'replace', label: `Replace with ${amountLabel(plan.next)}`, style: 'primary' },
        ...(added ? [{ id: 'add', label: `Add → ${added}`, style: 'secondary' as const }] : []),
        { id: 'cancel', label: 'Cancel', style: 'secondary' },
      ],
    };
  },
  async run(ctx, a, choice) {
    const mode = choice === 'add' || (choice !== 'replace' && a.mode === 'add') ? 'add' : 'set';
    const plan = await planLog(ctx, a, mode);
    const day = a.day as ISODate;
    const code = (a.code as EntryCode | undefined) ?? 'REG';
    const sheet = plan.sheet ?? (await ensureTimesheet(ctx.db, ctx.me.id, plan.period.id));
    if (plan.existing) {
      await changed(ctx.db.update('time_entries', plan.next).eq('id', plan.existing.id), 'that entry');
    } else {
      await rows(ctx.db.insert('time_entries', { timesheet_id: sheet.id, work_date: day, earning_code: code, ...plan.next }));
    }
    const total = periodTotal(await entriesFor(ctx.db, sheet.id));
    const was = plan.existing ? `${amountLabel(plan.existing)} → ` : '';
    return {
      text: `Logged ${was}${amountLabel(plan.next)} ${code} for ${dayLabel(day)}. ${monthLabel(plan.period.start_date)} total: ${plan.unit === 'days' ? amountLabel({ days: total.days }) : amountLabel({ hours: total.hours })}.`,
      changed: ['timesheets'],
      data: { day, code, ...plan.next },
      undo: { timesheet_id: sheet.id, day, code, previous: plan.existing ? { hours: plan.existing.hours, days: plan.existing.days } : null, wrote: plan.next },
    };
  },
  async undo(ctx, u) {
    type Value = { hours: number | null; days: number | null };
    const { timesheet_id, day, code, previous, wrote } = u as { timesheet_id: string; day: string; code: string; previous: Value | null; wrote: Value };
    // Only undo what this action wrote: if the day was edited since, leave it alone.
    const now = (await entriesFor(ctx.db, timesheet_id)).find((e) => e.work_date === day && e.earning_code === code);
    if (!now || now.hours !== wrote.hours || now.days !== wrote.days) {
      throw new Refusal(`${dayLabel(day)} has changed since (now ${now ? amountLabel(now) : 'nothing'} ${code}), so it was not undone.`);
    }
    const q = (b: ReturnType<typeof ctx.db.update>) => b.eq('timesheet_id', timesheet_id).eq('work_date', day).eq('earning_code', code);
    if (previous) await changed(q(ctx.db.update('time_entries', previous)), 'that entry');
    else await rows(ctx.db.delete('time_entries').eq('timesheet_id', timesheet_id).eq('work_date', day).eq('earning_code', code));
    return { text: `Undone: ${dayLabel(day)} is back to ${previous ? amountLabel(previous) : 'nothing'} ${code}.`, changed: ['timesheets'] };
  },
};

export const clearTime: AgentTool = {
  name: 'clear_time',
  roles: [...EVERYONE],
  description: 'remove the time logged on a date in my own timesheet',
  kind: 'write',
  args: {
    day: { type: 'date', required: true, slot: 'day', description: 'The day to clear' },
    code: { type: CODE, description: 'Only this earning code (default: every code that day)' },
  },
  async confirm(ctx, a) {
    const { removed } = await clearPlan(ctx, a);
    return {
      title: `Remove the time on ${dayLabel(a.day as string)}?`,
      lines: removed.map((e) => `${amountLabel(e)} ${e.earning_code}`),
      choices: [{ id: 'confirm', label: 'Remove', style: 'danger' }, { id: 'cancel', label: 'Cancel', style: 'secondary' }],
    };
  },
  async run(ctx, a) {
    const { removed } = await clearPlan(ctx, a);
    for (const e of removed) await rows(ctx.db.delete('time_entries').eq('id', e.id));
    return {
      text: `Removed ${removed.map((e) => `${amountLabel(e)} ${e.earning_code}`).join(', ')} from ${dayLabel(a.day as string)}.`,
      changed: ['timesheets'],
      undo: { entries: removed.map(({ id: _id, ...rest }) => rest) },
    };
  },
  async undo(ctx, u) {
    const { entries } = u as { entries: Omit<EntryRow, 'id'>[] };
    // Restore all or nothing: time logged on that day since would collide with the old entries.
    const sheets = [...new Set(entries.map((e) => e.timesheet_id))];
    const now = (await Promise.all(sheets.map((id) => entriesFor(ctx.db, id)))).flat();
    const taken = entries.filter((e) => now.some((n) => n.timesheet_id === e.timesheet_id && n.work_date === e.work_date && n.earning_code === e.earning_code));
    if (taken.length) {
      throw new Refusal(`${dayLabel(taken[0].work_date)} has time logged since (${taken.map((e) => e.earning_code).join(', ')}), so it was not undone.`);
    }
    for (const e of entries) await rows(ctx.db.insert('time_entries', { timesheet_id: e.timesheet_id, work_date: e.work_date, earning_code: e.earning_code, hours: e.hours, days: e.days }));
    return { text: `Undone: restored ${entries.map((e) => `${amountLabel(e)} ${e.earning_code}`).join(', ')}.`, changed: ['timesheets'] };
  },
};

async function clearPlan(ctx: ToolCtx, a: Record<string, unknown>): Promise<{ removed: EntryRow[] }> {
  const day = a.day as ISODate;
  const period = await periodFor(ctx.db, day);
  const sheet = period ? await findTimesheet(ctx.db, ctx.me.id, period.id) : null;
  if (!period || !sheet) throw new Refusal(`Nothing is logged on ${dayLabel(day)}.`);
  if (period.status !== 'open' || !['draft', 'rejected'].includes(sheet.status)) {
    throw new Refusal(`Your ${monthLabel(period.start_date)} timesheet is ${sheet.status} (period ${period.status}), so it can't be changed.`);
  }
  const removed = (await entriesFor(ctx.db, sheet.id)).filter((e) => e.work_date === day && (!a.code || e.earning_code === a.code));
  if (removed.length === 0) throw new Refusal(`Nothing is logged on ${dayLabel(day)}${a.code ? ` as ${a.code}` : ''}.`);
  return { removed };
}

async function sheetSummary(ctx: ToolCtx, periodId: unknown) {
  const period = await periodArg(ctx, periodId);
  const sheet = await findTimesheet(ctx.db, ctx.me.id, period.id);
  const entries = sheet ? await entriesFor(ctx.db, sheet.id) : [];
  const byCode = new Map<string, { hours: number; days: number }>();
  for (const e of entries) {
    const t = byCode.get(e.earning_code) ?? { hours: 0, days: 0 };
    byCode.set(e.earning_code, { hours: t.hours + (e.hours ?? 0), days: t.days + (e.days ?? 0) });
  }
  const totals = [...byCode].map(([code, t]) => `${t.days ? amountLabel({ days: t.days }) : amountLabel({ hours: t.hours })} ${code}`);
  const missing = missingWeekdays(period, new Set(entries.map((e) => e.work_date)), period.end_date);
  return { period, sheet, entries, totals, missing };
}

export const showTimesheet: AgentTool = {
  name: 'show_timesheet',
  roles: [...EVERYONE],
  description: 'show my timesheet for a month: what is logged, totals and status',
  kind: 'read',
  args: { period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the current one)' } },
  async run(ctx, a) {
    const s = await sheetSummary(ctx, a.period);
    const label = monthLabel(s.period.start_date);
    if (!s.sheet) return { text: `You haven't logged any time for ${label} yet.`, data: { period: label, status: 'not started' } };
    const note = s.sheet.status === 'rejected' && s.sheet.rejection_note ? ` Returned with the note: "${s.sheet.rejection_note}".` : '';
    return {
      text: `${label}: ${s.sheet.status}. ${s.totals.length ? `Total ${s.totals.join(', ')}.` : 'Nothing logged yet.'}${note}`,
      cards: s.entries.length ? [{
        kind: 'table', title: `${label} timesheet`, columns: ['Day', 'Code', 'Amount'],
        rows: s.entries.map((e) => [dayLabel(e.work_date), e.earning_code, amountLabel(e)]),
      }] : [],
      data: { period: label, status: s.sheet.status, totals: s.totals, entries: s.entries.map((e) => ({ day: e.work_date, code: e.earning_code, hours: e.hours, days: e.days })) },
    };
  },
};

export const submitTimesheet: AgentTool = {
  name: 'submit_timesheet',
  roles: [...EVERYONE],
  description: 'submit my timesheet for a month for approval',
  kind: 'write',
  args: { period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the current one)' } },
  async confirm(ctx, a) {
    const s = await sheetSummary(ctx, a.period);
    const label = monthLabel(s.period.start_date);
    if (!s.sheet || s.entries.length === 0) throw new Refusal(`There's no time logged for ${label} to submit.`);
    if (!['draft', 'rejected'].includes(s.sheet.status)) throw new Refusal(`Your ${label} timesheet is already ${s.sheet.status}.`);
    return {
      title: `Submit your ${label} timesheet?`,
      lines: [
        `Total: ${s.totals.join(', ')}`,
        s.missing.length ? `Weekdays with nothing logged: ${s.missing.map(dayLabel).join(', ')}` : 'Every weekday has time logged.',
      ],
      choices: [{ id: 'confirm', label: 'Submit', style: 'primary' }, { id: 'cancel', label: 'Cancel', style: 'secondary' }],
    };
  },
  async run(ctx, a) {
    const s = await sheetSummary(ctx, a.period);
    if (!s.sheet) throw new Refusal('There is no timesheet to submit.');
    // Only from draft/returned: a card clicked after the timesheet moved must not claim success.
    const moved = await rows(ctx.db.update('timesheets', { status: 'submitted' }).eq('id', s.sheet.id).in('status', ['draft', 'rejected']));
    if (!moved.length) throw new Refusal(`Your ${monthLabel(s.period.start_date)} timesheet is already ${(await sheetSummary(ctx, s.period.id)).sheet?.status ?? 'gone'}.`);
    return { text: `Submitted your ${monthLabel(s.period.start_date)} timesheet for approval.`, changed: ['timesheets'] };
  },
};

export const recallTimesheet: AgentTool = {
  name: 'recall_timesheet',
  roles: [...EVERYONE],
  description: 'take back my submitted timesheet so I can edit it',
  kind: 'write',
  args: { period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the current one)' } },
  async confirm(ctx, a) {
    const s = await sheetSummary(ctx, a.period);
    if (s.sheet?.status !== 'submitted') throw new Refusal(`Your ${monthLabel(s.period.start_date)} timesheet isn't waiting for approval, so there's nothing to recall.`);
    return { title: `Recall your ${monthLabel(s.period.start_date)} timesheet?`, lines: ['It goes back to draft so you can edit and resubmit it.'], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    const s = await sheetSummary(ctx, a.period);
    const moved = s.sheet ? await rows(ctx.db.update('timesheets', { status: 'draft' }).eq('id', s.sheet.id).eq('status', 'submitted')) : [];
    if (!moved.length) throw new Refusal(`Your ${monthLabel(s.period.start_date)} timesheet isn't waiting for approval, so there's nothing to recall.`);
    return { text: `Recalled your ${monthLabel(s.period.start_date)} timesheet. You can edit it now.`, changed: ['timesheets'] };
  },
};

export const showMyPay: AgentTool = {
  name: 'show_my_pay',
  roles: [...EVERYONE],
  description: 'show my gross pay from finalized payroll runs',
  kind: 'read',
  args: { period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the latest paid one)' } },
  async run(ctx, a) {
    type Line = { run_id: string; pay_period_id: string; earning_code: string; hours: unknown; days: unknown; amount_cents: number };
    const all = await selectAll<Line>((offset, limit) => {
      let q = ctx.db.from('payroll_run_lines').select('run_id,pay_period_id,earning_code,hours,days,amount_cents').eq('employee_id', ctx.me.id);
      if (typeof a.period === 'string') q = q.eq('pay_period_id', a.period);
      return q.order('id').limit(limit).offset(offset);
    });
    // RLS shows employees only finalized lines, but admins see draft and voided runs too.
    const runIds = [...new Set(all.map((l) => l.run_id))];
    const finalized = ctx.me.role === 'admin' && runIds.length
      ? new Set((await rows<{ id: string }>(ctx.db.from('payroll_runs').select('id').in('id', runIds).eq('status', 'finalized'))).map((r) => r.id))
      : null;
    const lines = finalized ? all.filter((l) => finalized.has(l.run_id)) : all;
    if (lines.length === 0) return { text: 'There is no finalized pay for you yet.' };
    const periods = await rows<{ id: string; start_date: string }>(ctx.db.from('pay_periods').select('id,start_date').in('id', [...new Set(lines.map((l) => l.pay_period_id))]));
    const latest = periods.map((p) => ({ ...p, start_date: isoDate(p.start_date) })).sort((x, y) => (x.start_date < y.start_date ? 1 : -1))[0];
    const mine = lines.filter((l) => l.pay_period_id === latest.id);
    const gross = mine.reduce((s, l) => s + Number(l.amount_cents), 0);
    return {
      text: `Gross pay for ${monthLabel(latest.start_date)}: ${money(gross)} (before taxes and deductions).`,
      cards: [{
        kind: 'table', title: `${monthLabel(latest.start_date)} pay`, columns: ['Code', 'Hours', 'Days', 'Amount'],
        rows: mine.map((l) => [l.earning_code, String(num(l.hours) ?? ''), String(num(l.days) ?? ''), money(Number(l.amount_cents))]),
      }],
      data: { period: monthLabel(latest.start_date), gross_cents: gross },
    };
  },
};

export const showProfile: AgentTool = {
  name: 'show_profile',
  roles: [...EVERYONE],
  description: 'show my profile: pay type, rate and manager',
  kind: 'read',
  args: {},
  async run(ctx) {
    const me = await getEmployee(ctx.db, ctx.me.id);
    const [comp] = await rows<{ pay_type: string; rate_cents: number; effective_from: string }>(ctx.db.from('compensation')
      .select('pay_type,rate_cents,effective_from').eq('employee_id', me.id).lte('effective_from', ctx.today).order('effective_from', { ascending: false }).limit(1));
    const unit = comp ? { salary: '/ year', hourly: '/ hour', daily: '/ day' }[comp.pay_type] : '';
    const pay = comp ? `${comp.pay_type}, ${money(Number(comp.rate_cents))} ${unit}` : 'not set up yet';
    return {
      text: `${me.first_name} ${me.last_name} (${me.email}), ${me.role}. Pay: ${pay}.`,
      data: { name: `${me.first_name} ${me.last_name}`, role: me.role, pay },
    };
  },
};

export const TIME_TOOLS = [logTime, clearTime, showTimesheet, submitTimesheet, recallTimesheet, showMyPay, showProfile];
