// Admin payroll tools: pay periods and payroll runs. Runs and exports go through the
// deployed payroll-run / payroll-export Functions, so their checks and audit apply.
import { monthBounds } from '../../lib/dates';
import { PRESETS } from '../../lib/exporters';
import { EARNING_CODES, type CalcWarning, type RunTotals } from '../../lib/types';
import { rows } from '../../server/db';
import { changed, fullName, getPeriod, getRun, listEmployees, listPeriods } from '../queries';
import { Refusal, type AgentTool, type Card, type ToolCtx } from '../types';
import { CONFIRM_CHOICES, DANGER_CHOICES, money, monthLabel, periodArg } from './common';

const ADMIN = ['admin'] as const;
const FORMATS = PRESETS.map((p) => p.key);

const totalsText = (t: RunTotals) => `${money(t.gross_cents)} gross for ${t.employee_count} employee${t.employee_count === 1 ? '' : 's'}`;

function totalsCard(title: string, t: RunTotals): Card {
  return {
    kind: 'table', title, columns: ['Code', 'Hours', 'Days', 'Amount'],
    rows: EARNING_CODES.filter((c) => t.by_code[c]).map((c) => [c, String(t.by_code[c]!.hours), String(t.by_code[c]!.days), money(t.by_code[c]!.amount_cents)]),
  };
}

async function runLabel(ctx: ToolCtx, runId: string) {
  const run = await getRun(ctx.db, runId);
  const period = await getPeriod(ctx.db, run.pay_period_id);
  return { run, month: monthLabel(period.start_date) };
}

export const listPeriodsTool: AgentTool = {
  name: 'list_periods',
  roles: [...ADMIN],
  description: 'list pay periods and their status',
  kind: 'read',
  args: {},
  async run(ctx) {
    const periods = await listPeriods(ctx.db);
    if (periods.length === 0) return { text: 'No pay periods yet. Say "open this month" to start one.' };
    return {
      text: periods.map((p) => `${monthLabel(p.start_date)}: ${p.status}`).join('; ') + '.',
      cards: [{ kind: 'table', title: 'Pay periods', columns: ['Month', 'Status'], rows: periods.map((p) => [monthLabel(p.start_date), p.status]) }],
      data: periods.map((p) => ({ period: p.id, month: monthLabel(p.start_date), status: p.status })),
    };
  },
};

export const openPeriod: AgentTool = {
  name: 'open_period',
  roles: [...ADMIN],
  description: 'open a month as a new pay period so people can log time',
  kind: 'write',
  args: { month: { type: 'month', required: true, slot: 'month', description: 'The month, YYYY-MM' } },
  async confirm(_ctx, a) {
    const { start } = monthBounds(a.month as string);
    return { title: `Open ${monthLabel(start)} for time entry?`, lines: ['Employees can then log time for that month.'], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    const { start, end } = monthBounds(a.month as string);
    await rows(ctx.db.insert('pay_periods', { start_date: start, end_date: end }));
    return { text: `${monthLabel(start)} is open for time entry.`, changed: ['periods'] };
  },
};

function statusTool(name: string, description: string, to: 'locked' | 'open', verb: string, note: string): AgentTool {
  return {
    name,
    roles: [...ADMIN],
    description,
    kind: 'write',
    args: { period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the current one)' } },
    async confirm(ctx, a) {
      const p = await periodArg(ctx, a.period);
      return { title: `${verb} ${monthLabel(p.start_date)}?`, lines: [note], choices: CONFIRM_CHOICES };
    },
    async run(ctx, a) {
      const p = await periodArg(ctx, a.period);
      await changed(ctx.db.update('pay_periods', { status: to }).eq('id', p.id), `${monthLabel(p.start_date)}`);
      return { text: `${monthLabel(p.start_date)} is ${to}.`, changed: ['periods'] };
    },
  };
}

export const lockPeriod = statusTool('lock_period', 'lock a pay period so time can no longer change, ready for a payroll run', 'locked', 'Lock', 'Nobody can change time for that month afterwards.');
export const reopenPeriod = statusTool('reopen_period', 'reopen a locked pay period for time changes', 'open', 'Reopen', 'Employees can change their time again.');

export const generateRun: AgentTool = {
  name: 'generate_run',
  roles: [...ADMIN],
  description: 'calculate a draft payroll run for a locked pay period (replaces an existing draft)',
  kind: 'write',
  args: {
    period: { type: 'uuid', slot: 'period', description: 'Pay period (default: the current one)' },
    leave_out: { type: 'uuids', description: 'Employees to leave out of this run' },
  },
  async confirm(ctx, a) {
    const p = await periodArg(ctx, a.period);
    if (p.status !== 'locked') throw new Refusal(`${monthLabel(p.start_date)} is ${p.status}. Lock it before generating a run.`);
    const left = (a.leave_out as string[] | undefined) ?? [];
    const names = left.length ? (await listEmployees(ctx.db)).filter((e) => left.includes(e.id)).map(fullName) : [];
    return {
      title: `Generate the ${monthLabel(p.start_date)} payroll run?`,
      lines: [names.length ? `Leaving out: ${names.join(', ')}` : 'Everyone employed that month is included.', 'Any existing draft for that month is replaced.'],
      choices: CONFIRM_CHOICES,
    };
  },
  async run(ctx, a) {
    const p = await periodArg(ctx, a.period);
    const r = await ctx.invoke<{ run_id: string; totals: RunTotals; warnings: CalcWarning[]; line_count: number }>('payroll-run', {
      action: 'generate', period_id: p.id, skipped_employee_ids: (a.leave_out as string[] | undefined) ?? [],
    });
    const blocking = r.warnings.filter((w) => w.blocking);
    const cards: Card[] = [totalsCard(`${monthLabel(p.start_date)} draft`, r.totals)];
    if (r.warnings.length) cards.push({ kind: 'table', title: 'Warnings', columns: ['', 'Warning'], rows: r.warnings.map((w) => [w.blocking ? 'Must fix' : 'Note', w.message]) });
    return {
      text: `Draft run for ${monthLabel(p.start_date)}: ${totalsText(r.totals)}.${blocking.length ? ` ${blocking.length} warning${blocking.length === 1 ? '' : 's'} must be fixed (or those people left out) before it can be finalized.` : ' Ready to finalize.'}`,
      cards,
      changed: ['runs'],
      data: { run: r.run_id, totals: r.totals, warnings: r.warnings },
    };
  },
};

export const explainRun: AgentTool = {
  name: 'explain_run',
  roles: [...ADMIN],
  description: "show a payroll run's totals and warnings",
  kind: 'read',
  args: { run: { type: 'uuid', required: true, slot: 'run', description: 'The payroll run' } },
  async run(ctx, a) {
    const { run, month } = await runLabel(ctx, a.run as string);
    const cards: Card[] = [totalsCard(`${month} run (${run.status})`, run.totals)];
    if (run.warnings.length) cards.push({ kind: 'table', title: 'Warnings', columns: ['', 'Warning'], rows: run.warnings.map((w) => [w.blocking ? 'Must fix' : 'Note', w.message]) });
    return { text: `${month} run (${run.status}): ${totalsText(run.totals)}, ${run.warnings.length} warning(s).`, cards, data: { status: run.status, totals: run.totals, warnings: run.warnings } };
  },
};

function runAction(name: string, description: string, action: 'finalize' | 'discard', need: 'draft', verb: string, note: string): AgentTool {
  return {
    name,
    roles: [...ADMIN],
    description,
    kind: 'write',
    args: { run: { type: 'uuid', required: true, slot: 'run', description: 'The payroll run' } },
    async confirm(ctx, a) {
      const { run, month } = await runLabel(ctx, a.run as string);
      if (run.status !== need) throw new Refusal(`The ${month} run is ${run.status}, not a ${need}.`);
      return { title: `${verb} the ${month} run?`, lines: [`${totalsText(run.totals)}.`, note], choices: action === 'discard' ? DANGER_CHOICES : CONFIRM_CHOICES };
    },
    async run(ctx, a) {
      const { month } = await runLabel(ctx, a.run as string);
      await ctx.invoke('payroll-run', { action, run_id: a.run });
      return { text: action === 'finalize' ? `The ${month} run is finalized. You can export it now.` : `Discarded the ${month} draft.`, changed: ['runs', 'periods'] };
    },
  };
}

export const finalizeRun = runAction('finalize_run', 'finalize a draft payroll run (freezes it and notifies integrations)', 'finalize', 'draft', 'Finalize', 'Lines are frozen and integrations are notified.');
export const discardDraft = runAction('discard_draft', 'throw away a draft payroll run', 'discard', 'draft', 'Discard', 'You can generate a new draft afterwards.');

export const voidRun: AgentTool = {
  name: 'void_run',
  roles: [...ADMIN],
  description: 'void a finalized payroll run, with a reason (the period goes back to locked)',
  kind: 'write',
  args: {
    run: { type: 'uuid', required: true, slot: 'run', description: 'The finalized run' },
    reason: { type: 'string', required: true, slot: 'note', description: 'Why the run is being voided' },
  },
  async confirm(ctx, a) {
    const { run, month } = await runLabel(ctx, a.run as string);
    if (run.status !== 'finalized') throw new Refusal(`The ${month} run is ${run.status}; only finalized runs can be voided.`);
    return { title: `Void the finalized ${month} run?`, lines: [`Reason: "${a.reason}"`, 'Integrations are notified and the month goes back to locked.'], choices: DANGER_CHOICES };
  },
  async run(ctx, a) {
    const { month } = await runLabel(ctx, a.run as string);
    await ctx.invoke('payroll-run', { action: 'void', run_id: a.run, reason: a.reason });
    return { text: `The ${month} run is voided and the month is locked again.`, changed: ['runs', 'periods'] };
  },
};

export const exportRun: AgentTool = {
  name: 'export_run',
  roles: [...ADMIN],
  description: `export a finalized payroll run as a file for a payroll provider (${FORMATS.join(', ')}, or custom:<id>)`,
  kind: 'write',
  args: {
    run: { type: 'uuid', required: true, slot: 'run', description: 'The finalized run' },
    format: { type: 'string', required: true, slot: 'format', description: `Export format: ${FORMATS.join(', ')} or custom:<mapping id>` },
  },
  async confirm(ctx, a) {
    const { run, month } = await runLabel(ctx, a.run as string);
    if (run.status !== 'finalized') throw new Refusal(`The ${month} run is ${run.status}; finalize it before exporting.`);
    const name = PRESETS.find((p) => p.key === a.format)?.name ?? String(a.format);
    return { title: `Export the ${month} run as ${name}?`, lines: ['The file is recorded with the run and downloaded here.'], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    const f = await ctx.invoke<{ filename: string; content_type: string; body: string; warnings?: string[] }>('payroll-export', { run_id: a.run, mapping_key: a.format });
    const warnings = f.warnings ?? [];
    return {
      text: `Export ready: ${f.filename}.${warnings.length ? ` This format leaves out some pay: ${warnings.join('; ')}.` : ''}`,
      cards: [{ kind: 'download', filename: f.filename, contentType: f.content_type, body: f.body, warnings }],
      changed: ['runs'],
      data: { filename: f.filename, warnings },
    };
  },
};

export const PAYROLL_TOOLS = [listPeriodsTool, openPeriod, lockPeriod, reopenPeriod, generateRun, explainRun, finalizeRun, discardDraft, voidRun, exportRun];
