import type { VolcanoAuth } from '@volcano.dev/sdk';
import { addDays, monthBounds, weekStart, type ISODate } from '../lib/dates';
import type { CalcInput, CalcTimesheet, CompSegment, EntryCode, OvertimeSettings, PayType, TimeEntry, TimesheetStatus } from '../lib/types';
import { chunk, isoDate, num, one, rows, selectAll } from './db';

export interface PeriodRow { id: string; start_date: ISODate; end_date: ISODate; status: 'open' | 'locked' | 'finalized' }

interface EmployeeRow {
  id: string; external_id: string | null; first_name: string; last_name: string; email: string;
  work_state: string | null; hire_date: string; termination_date: string | null;
}
interface TimesheetRow { id: string; employee_id: string; status: TimesheetStatus }
interface EntryRow { timesheet_id: string; work_date: string; earning_code: EntryCode; hours: unknown; days: unknown }

export async function loadPeriod(db: VolcanoAuth, periodId: string): Promise<PeriodRow> {
  const p = await one<PeriodRow>(db.from('pay_periods').select('id,start_date,end_date,status').eq('id', periodId), 'Pay period not found');
  return { ...p, start_date: isoDate(p.start_date), end_date: isoDate(p.end_date) };
}

export async function loadSettings(db: VolcanoAuth): Promise<OvertimeSettings> {
  const s = await one<Record<string, unknown>>(db.from('settings').select(
    'ot_weekly_threshold,ot_daily_threshold,dt_daily_threshold,ot_multiplier,dt_multiplier,ot_applies_to_daily,week_starts_on'));
  return {
    ot_weekly_threshold: num(s.ot_weekly_threshold),
    ot_daily_threshold: num(s.ot_daily_threshold),
    dt_daily_threshold: num(s.dt_daily_threshold),
    ot_multiplier: num(s.ot_multiplier) ?? 1.5,
    dt_multiplier: num(s.dt_multiplier) ?? 2,
    ot_applies_to_daily: s.ot_applies_to_daily === true,
    week_starts_on: num(s.week_starts_on) ?? 0,
  };
}

async function loadTimesheets(db: VolcanoAuth, periodId: string): Promise<TimesheetRow[]> {
  return selectAll<TimesheetRow>((o, l) =>
    db.from('timesheets').select('id,employee_id,status').eq('pay_period_id', periodId).order('id').limit(l).offset(o));
}

async function loadEntries(db: VolcanoAuth, timesheetIds: string[]): Promise<EntryRow[]> {
  const out: EntryRow[] = [];
  for (const ids of chunk(timesheetIds, 100)) {
    out.push(...await selectAll<EntryRow>((o, l) =>
      db.from('time_entries').select('timesheet_id,work_date,earning_code,hours,days').in('timesheet_id', ids).order('id').limit(l).offset(o)));
  }
  return out;
}

const toEntry = (e: EntryRow): TimeEntry => ({
  work_date: isoDate(e.work_date), earning_code: e.earning_code, hours: num(e.hours), days: num(e.days),
});

/** Everything calculateRun needs for one period. */
export async function loadCalcInput(db: VolcanoAuth, period: PeriodRow, skippedEmployeeIds: string[]): Promise<CalcInput> {
  const settings = await loadSettings(db);

  const employees = (await selectAll<EmployeeRow>((o, l) =>
    db.from('employees').select('id,external_id,first_name,last_name,email,work_state,hire_date,termination_date')
      .lte('hire_date', period.end_date).order('id').limit(l).offset(o)))
    .map((e) => ({ ...e, hire_date: isoDate(e.hire_date), termination_date: e.termination_date ? isoDate(e.termination_date) : null }))
    .filter((e) => !e.termination_date || e.termination_date >= period.start_date);

  const compensation: CompSegment[] = (await selectAll<{ employee_id: string; pay_type: PayType; rate_cents: unknown; effective_from: string }>((o, l) =>
    db.from('compensation').select('employee_id,pay_type,rate_cents,effective_from').order('id').limit(l).offset(o)))
    .map((c) => ({ ...c, rate_cents: Number(c.rate_cents), effective_from: isoDate(c.effective_from) }));

  const sheets = await loadTimesheets(db, period.id);
  const entries = await loadEntries(db, sheets.map((t) => t.id));
  const timesheets: CalcTimesheet[] = sheets.map((t) => ({
    employee_id: t.employee_id,
    status: t.status,
    entries: entries.filter((e) => e.timesheet_id === t.id).map(toEntry),
  }));

  // Approved entries from the previous month that share the first workweek.
  const priorEntries: Record<string, TimeEntry[]> = {};
  const firstWeek = weekStart(period.start_date, settings.week_starts_on);
  if (firstWeek < period.start_date) {
    const prevStart = monthBounds(addDays(period.start_date, -1).slice(0, 7)).start;
    const [prev] = await rows<{ id: string }>(db.from('pay_periods').select('id').eq('start_date', prevStart).limit(1));
    if (prev) {
      const prevSheets = (await loadTimesheets(db, prev.id)).filter((t) => t.status === 'approved');
      const prevEntries = await loadEntries(db, prevSheets.map((t) => t.id));
      for (const t of prevSheets) {
        priorEntries[t.employee_id] = prevEntries
          .filter((e) => e.timesheet_id === t.id).map(toEntry)
          .filter((e) => e.work_date >= firstWeek);
      }
    }
  }

  return {
    period: { start: period.start_date, end: period.end_date },
    employees,
    compensation,
    timesheets,
    priorEntries,
    settings,
    skippedEmployeeIds,
  };
}
