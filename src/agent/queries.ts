// Database reads and writes the agent's tools share. Every function takes the signed-in
// user's client, so row-level security decides what each one can see or change.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import type { ISODate } from '../lib/dates';
import type { EntryCode, PayType, RunTotals, TimesheetStatus } from '../lib/types';
import { isoDate, num, one, rows } from '../server/db';
import { HttpError } from '../server/http';
import type { PendingRef, PeriodRef, PersonRef, RunRef } from './types';

export interface TimesheetRow { id: string; employee_id: string; pay_period_id: string; status: TimesheetStatus; rejection_note: string | null }
export interface EntryRow { id: string; timesheet_id: string; work_date: ISODate; earning_code: EntryCode; hours: number | null; days: number | null }
export interface EmployeeRow {
  id: string; email: string; first_name: string; last_name: string; external_id: string | null; role: 'employee' | 'manager' | 'admin';
  manager_id: string | null; status: 'active' | 'terminated'; hire_date: ISODate; termination_date: ISODate | null; work_state: string | null;
}
export interface RunRow { id: string; pay_period_id: string; status: RunRef['status']; totals: RunTotals; warnings: { employee_id: string; code: string; blocking: boolean; message: string }[] }

const EMPLOYEE_COLUMNS = 'id,email,first_name,last_name,external_id,role,manager_id,status,hire_date,termination_date,work_state';
export const fullName = (e: { first_name: string; last_name: string }): string => `${e.first_name} ${e.last_name}`;

const toEmployee = (e: EmployeeRow): EmployeeRow => ({
  ...e, hire_date: isoDate(e.hire_date), termination_date: e.termination_date ? isoDate(e.termination_date) : null,
});

export async function listPeriods(db: VolcanoAuth, limit = 12): Promise<PeriodRef[]> {
  const out = await rows<PeriodRef>(db.from('pay_periods').select('id,start_date,end_date,status').order('start_date', { ascending: false }).limit(limit));
  return out.map((p) => ({ ...p, start_date: isoDate(p.start_date), end_date: isoDate(p.end_date) }));
}

/** The period containing `day`, else the latest open one, else the latest. */
export function currentPeriod(periods: PeriodRef[], day: ISODate): PeriodRef | null {
  return periods.find((p) => p.start_date <= day && day <= p.end_date)
    ?? periods.find((p) => p.status === 'open')
    ?? periods[0]
    ?? null;
}

export async function payTypeOn(db: VolcanoAuth, employeeId: string, day: ISODate): Promise<PayType | null> {
  const [c] = await rows<{ pay_type: PayType }>(db.from('compensation').select('pay_type')
    .eq('employee_id', employeeId).lte('effective_from', day).order('effective_from', { ascending: false }).limit(1));
  return c?.pay_type ?? null;
}

export async function findTimesheet(db: VolcanoAuth, employeeId: string, periodId: string): Promise<TimesheetRow | null> {
  const [t] = await rows<TimesheetRow>(db.from('timesheets').select('id,employee_id,pay_period_id,status,rejection_note')
    .eq('employee_id', employeeId).eq('pay_period_id', periodId).limit(1));
  return t ?? null;
}

export async function getTimesheet(db: VolcanoAuth, id: string): Promise<TimesheetRow> {
  return one<TimesheetRow>(db.from('timesheets').select('id,employee_id,pay_period_id,status,rejection_note').eq('id', id), 'Timesheet not found');
}

/** The user's timesheet for a period, created (as a draft) when missing. */
export async function ensureTimesheet(db: VolcanoAuth, employeeId: string, periodId: string): Promise<TimesheetRow> {
  const existing = await findTimesheet(db, employeeId, periodId);
  if (existing) return existing;
  const [created] = await rows<TimesheetRow>(db.insert('timesheets', { employee_id: employeeId, pay_period_id: periodId }));
  return created;
}

export async function entriesFor(db: VolcanoAuth, timesheetId: string): Promise<EntryRow[]> {
  const out = await rows<EntryRow>(db.from('time_entries').select('id,timesheet_id,work_date,earning_code,hours,days')
    .eq('timesheet_id', timesheetId).order('work_date').limit(500));
  return out.map((e) => ({ ...e, work_date: isoDate(e.work_date), hours: num(e.hours), days: num(e.days) }));
}

export async function getPeriod(db: VolcanoAuth, id: string): Promise<PeriodRef> {
  const p = await one<PeriodRef>(db.from('pay_periods').select('id,start_date,end_date,status').eq('id', id), 'Pay period not found');
  return { ...p, start_date: isoDate(p.start_date), end_date: isoDate(p.end_date) };
}

/** The period that contains a day, if one has been opened. */
export async function periodFor(db: VolcanoAuth, day: ISODate): Promise<PeriodRef | null> {
  const [p] = await rows<PeriodRef>(db.from('pay_periods').select('id,start_date,end_date,status').lte('start_date', day).gte('end_date', day).limit(1));
  return p ? { ...p, start_date: isoDate(p.start_date), end_date: isoDate(p.end_date) } : null;
}

export async function listEmployees(db: VolcanoAuth): Promise<EmployeeRow[]> {
  const out = await rows<EmployeeRow>(db.from('employees').select(EMPLOYEE_COLUMNS).order('last_name').order('first_name').limit(1000));
  return out.map(toEmployee);
}

export async function getEmployee(db: VolcanoAuth, id: string): Promise<EmployeeRow> {
  return toEmployee(await one<EmployeeRow>(db.from('employees').select(EMPLOYEE_COLUMNS).eq('id', id), 'Employee not found'));
}

/**
 * Timesheets the user can act on as an approver: submitted ones in unfinalized periods,
 * plus (admins) unsubmitted ones of people who have left. RLS limits managers to reports.
 */
export async function pendingApprovals(
  db: VolcanoAuth, me: { id: string; role: string }, periods: PeriodRef[], employees?: Promise<EmployeeRow[]>,
): Promise<PendingRef[]> {
  if (me.role === 'employee') return [];
  const live = periods.filter((p) => p.status !== 'finalized').map((p) => p.id);
  if (live.length === 0) return [];
  const sheets = await rows<TimesheetRow>(db.from('timesheets').select('id,employee_id,pay_period_id,status,rejection_note')
    .in('pay_period_id', live).in('status', ['submitted', 'draft', 'rejected']).limit(2000));
  if (sheets.length === 0) return [];
  const people = new Map((await (employees ?? listEmployees(db))).map((e) => [e.id, e]));
  return sheets
    .filter((s) => {
      const e = people.get(s.employee_id);
      if (!e) return false;
      if (s.status === 'submitted') return s.employee_id !== me.id || me.role === 'admin';
      return me.role === 'admin' && e.status === 'terminated';
    })
    .map((s) => ({ id: s.id, employee_id: s.employee_id, name: fullName(people.get(s.employee_id)!), period_id: s.pay_period_id, status: s.status }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listRuns(db: VolcanoAuth): Promise<RunRef[]> {
  const out = await rows<{ id: string; pay_period_id: string; status: RunRef['status'] }>(db.from('payroll_runs')
    .select('id,pay_period_id,status').order('generated_at', { ascending: false }).limit(24));
  return out.map((r) => ({ id: r.id, period_id: r.pay_period_id, status: r.status }));
}

export async function getRun(db: VolcanoAuth, id: string): Promise<RunRow> {
  return one<RunRow>(db.from('payroll_runs').select('id,pay_period_id,status,totals,warnings').eq('id', id), 'Payroll run not found');
}

/** The run that counts for a period: the draft or finalized one (never a voided one). */
export async function activeRunFor(db: VolcanoAuth, periodId: string): Promise<RunRow | null> {
  const [r] = await rows<RunRow>(db.from('payroll_runs').select('id,pay_period_id,status,totals,warnings')
    .eq('pay_period_id', periodId).in('status', ['draft', 'finalized']).limit(1));
  return r ?? null;
}

export function peopleRefs(list: EmployeeRow[]): PersonRef[] {
  return list.map((e) => ({ id: e.id, name: fullName(e), email: e.email, status: e.status }));
}

/** A write that RLS filtered out returns no rows and no error: turn that into a refusal. */
export async function changed<T>(q: PromiseLike<{ data: unknown; error: Error | null }>, what: string): Promise<T[]> {
  const out = await rows<T>(q);
  if (out.length === 0) throw new HttpError(403, 'FORBIDDEN', `You can't change ${what}, or it no longer exists`);
  return out;
}
