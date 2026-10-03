import type { VolcanoAuth } from '@volcano.dev/sdk';
import type { ExportLine, ExportRun } from '../lib/exporters';
import type { EarningCode, PayType, RunTotals } from '../lib/types';
import { isoDate, num, one, selectAll } from './db';

export interface RunRow {
  id: string;
  pay_period_id: string;
  status: 'draft' | 'finalized' | 'voided';
  totals: RunTotals;
  warnings: unknown[];
  finalized_at: string | null;
  voided_at: string | null;
}

interface LineRow {
  employee_id: string; external_id: string | null; first_name: string; last_name: string; email: string;
  pay_type: PayType; work_state: string | null; earning_code: EarningCode;
  hours: unknown; days: unknown; rate_cents: unknown; amount_cents: unknown;
}

export async function loadRun(db: VolcanoAuth, runId: string): Promise<{ run: RunRow; exportRun: ExportRun }> {
  const run = await one<RunRow>(db.from('payroll_runs')
    .select('id,pay_period_id,status,totals,warnings,finalized_at,voided_at').eq('id', runId), 'Payroll run not found');
  const p = await one<{ start_date: string; end_date: string }>(db.from('pay_periods').select('start_date,end_date').eq('id', run.pay_period_id));
  return {
    run,
    exportRun: { id: run.id, period_start: isoDate(p.start_date), period_end: isoDate(p.end_date), finalized_at: run.finalized_at, totals: run.totals },
  };
}

export async function loadRunLines(db: VolcanoAuth, runId: string): Promise<ExportLine[]> {
  const raw = await selectAll<LineRow>((o, l) => db.from('payroll_run_lines')
    .select('employee_id,external_id,first_name,last_name,email,pay_type,work_state,earning_code,hours,days,rate_cents,amount_cents')
    .eq('run_id', runId).order('id').limit(l).offset(o));
  return raw.map((l) => ({
    ...l, hours: num(l.hours), days: num(l.days), rate_cents: Number(l.rate_cents), amount_cents: Number(l.amount_cents),
  }));
}
