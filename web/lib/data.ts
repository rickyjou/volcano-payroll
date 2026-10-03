'use client';
// Typed reads shared by several pages. All run as the signed-in user under RLS.
import type { EntryCode, PayType, RunTotals, TimesheetStatus } from '../../src/lib/types';
import type { OvertimeSettings } from '../../src/lib/types';
import { q } from './api';
import { getVolcano } from './volcano';

export interface Period { id: string; start_date: string; end_date: string; status: 'open' | 'locked' | 'finalized' }
export interface Timesheet { id: string; employee_id: string; pay_period_id: string; status: TimesheetStatus; rejection_note: string | null; submitted_at: string | null; approved_at: string | null }
export interface Entry { id: string; timesheet_id: string; work_date: string; earning_code: EntryCode; hours: number | null; days: number | null }
export interface Comp { id: string; employee_id: string; pay_type: PayType; rate_cents: number; effective_from: string }
export interface EmployeeRow {
  id: string; user_id: string | null; email: string; first_name: string; last_name: string; external_id: string | null;
  role: 'employee' | 'manager' | 'admin'; manager_id: string | null; status: 'active' | 'terminated';
  hire_date: string; termination_date: string | null; work_state: string | null;
}
export interface Run { id: string; pay_period_id: string; status: 'draft' | 'finalized' | 'voided'; totals: RunTotals; warnings: { employee_id: string; code: string; blocking: boolean; message: string }[]; skipped_employee_ids: string[]; generated_at: string; finalized_at: string | null; voided_at: string | null; void_reason: string | null }

const day = (v: unknown) => String(v).slice(0, 10);
const n = (v: unknown) => (v == null ? null : Number(v));

export const EMPLOYEE_COLUMNS = 'id,user_id,email,first_name,last_name,external_id,role,manager_id,status,hire_date,termination_date,work_state';

export async function listPeriods(): Promise<Period[]> {
  const rows = await q<Period>(getVolcano().from('pay_periods').select('id,start_date,end_date,status').order('start_date', { ascending: false }).limit(36));
  return rows.map((p) => ({ ...p, start_date: day(p.start_date), end_date: day(p.end_date) }));
}

export async function listEmployees(): Promise<EmployeeRow[]> {
  const out: EmployeeRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await q<EmployeeRow>(getVolcano().from('employees').select(EMPLOYEE_COLUMNS).order('last_name').order('first_name').limit(1000).offset(offset));
    out.push(...batch.map((e) => ({ ...e, hire_date: day(e.hire_date), termination_date: e.termination_date ? day(e.termination_date) : null })));
    if (batch.length < 1000) return out;
  }
}

export async function timesheetsForPeriod(periodId: string): Promise<Timesheet[]> {
  return q<Timesheet>(getVolcano().from('timesheets')
    .select('id,employee_id,pay_period_id,status,rejection_note,submitted_at,approved_at').eq('pay_period_id', periodId).limit(5000));
}

export async function entriesFor(timesheetId: string): Promise<Entry[]> {
  const rows = await q<Entry>(getVolcano().from('time_entries').select('id,timesheet_id,work_date,earning_code,hours,days')
    .eq('timesheet_id', timesheetId).order('work_date').limit(500));
  return rows.map((e) => ({ ...e, work_date: day(e.work_date), hours: n(e.hours), days: n(e.days) }));
}

export async function compensationFor(employeeId: string): Promise<Comp[]> {
  const rows = await q<Comp>(getVolcano().from('compensation').select('id,employee_id,pay_type,rate_cents,effective_from')
    .eq('employee_id', employeeId).order('effective_from', { ascending: false }));
  return rows.map((c) => ({ ...c, rate_cents: Number(c.rate_cents), effective_from: day(c.effective_from) }));
}

/** The compensation in effect at the end of a period (what the timesheet grid should ask for). */
export const compAt = (comps: Comp[], date: string): Comp | null =>
  comps.filter((c) => c.effective_from <= date).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;

export interface SettingsRow extends OvertimeSettings { company_name: string }

export async function loadSettings(): Promise<SettingsRow> {
  const [s] = await q<Record<string, unknown>>(getVolcano().from('settings')
    .select('company_name,ot_weekly_threshold,ot_daily_threshold,dt_daily_threshold,ot_multiplier,dt_multiplier,ot_applies_to_daily,week_starts_on'));
  return {
    company_name: String(s?.company_name ?? ''),
    ot_weekly_threshold: n(s?.ot_weekly_threshold),
    ot_daily_threshold: n(s?.ot_daily_threshold),
    dt_daily_threshold: n(s?.dt_daily_threshold),
    ot_multiplier: n(s?.ot_multiplier) ?? 1.5,
    dt_multiplier: n(s?.dt_multiplier) ?? 2,
    ot_applies_to_daily: s?.ot_applies_to_daily === true,
    week_starts_on: n(s?.week_starts_on) ?? 0,
  };
}

export async function listRuns(): Promise<Run[]> {
  return q<Run>(getVolcano().from('payroll_runs')
    .select('id,pay_period_id,status,totals,warnings,skipped_employee_ids,generated_at,finalized_at,voided_at,void_reason')
    .order('generated_at', { ascending: false }).limit(100));
}
