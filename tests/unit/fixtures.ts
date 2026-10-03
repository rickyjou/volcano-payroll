import type { CalcEmployee, CalcInput, CompSegment, OvertimeSettings, TimeEntry } from '../../src/lib/types';

export const SEPT = { start: '2026-09-01', end: '2026-09-30' };

export const FEDERAL: OvertimeSettings = {
  ot_weekly_threshold: 40,
  ot_daily_threshold: null,
  dt_daily_threshold: null,
  ot_multiplier: 1.5,
  dt_multiplier: 2,
  ot_applies_to_daily: false,
  week_starts_on: 0,
};

export function emp(id: string, extra: Partial<CalcEmployee> = {}): CalcEmployee {
  return {
    id,
    external_id: `X-${id}`,
    first_name: 'Ada',
    last_name: id.toUpperCase(),
    email: `${id}@example.com`,
    work_state: 'CA',
    hire_date: '2020-01-01',
    termination_date: null,
    ...extra,
  };
}

export const comp = (employee_id: string, pay_type: CompSegment['pay_type'], rate_cents: number, effective_from = '2020-01-01'): CompSegment =>
  ({ employee_id, pay_type, rate_cents, effective_from });

export const reg = (work_date: string, hours: number | null, days: number | null = null): TimeEntry =>
  ({ work_date, earning_code: 'REG', hours, days });

export const off = (code: 'PTO' | 'SICK' | 'HOL', work_date: string, hours: number | null, days: number | null = null): TimeEntry =>
  ({ work_date, earning_code: code, hours, days });

/** Same hours on each listed day. */
export const days = (dates: string[], hours: number): TimeEntry[] => dates.map((d) => reg(d, hours));

export const WEEK_SEP_7 = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];

export function input(over: Partial<CalcInput>): CalcInput {
  return {
    period: SEPT,
    employees: [],
    compensation: [],
    timesheets: [],
    priorEntries: {},
    settings: FEDERAL,
    skippedEmployeeIds: [],
    ...over,
  };
}

/** One approved employee with the given compensation and entries. */
export function single(c: CompSegment[], entries: TimeEntry[], over: Partial<CalcInput> = {}, e = emp('a')): CalcInput {
  return input({
    employees: [e],
    compensation: c,
    timesheets: [{ employee_id: e.id, status: 'approved', entries }],
    ...over,
  });
}
