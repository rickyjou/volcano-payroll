import type { ISODate } from './dates';

export type PayType = 'salary' | 'hourly' | 'daily';
export type EntryCode = 'REG' | 'PTO' | 'SICK' | 'HOL';
export type EarningCode = EntryCode | 'OT' | 'DT' | 'SAL';
export const ENTRY_CODES: EntryCode[] = ['REG', 'PTO', 'SICK', 'HOL'];
export const EARNING_CODES: EarningCode[] = ['SAL', 'REG', 'OT', 'DT', 'PTO', 'SICK', 'HOL'];

export interface CalcEmployee {
  id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  work_state: string | null;
  hire_date: ISODate;
  termination_date: ISODate | null;
}

export interface CompSegment {
  employee_id: string;
  pay_type: PayType;
  /** salary: annual; hourly: per hour; daily: per day — all in cents */
  rate_cents: number;
  effective_from: ISODate;
}

export interface TimeEntry {
  work_date: ISODate;
  earning_code: EntryCode;
  hours: number | null;
  days: number | null;
}

export type TimesheetStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface CalcTimesheet {
  employee_id: string;
  status: TimesheetStatus;
  entries: TimeEntry[];
}

export interface OvertimeSettings {
  ot_weekly_threshold: number | null;
  ot_daily_threshold: number | null;
  dt_daily_threshold: number | null;
  ot_multiplier: number;
  dt_multiplier: number;
  ot_applies_to_daily: boolean;
  /** 0 = Sunday … 6 = Saturday */
  week_starts_on: number;
}

export interface CalcInput {
  period: { start: ISODate; end: ISODate };
  employees: CalcEmployee[];
  compensation: CompSegment[];
  timesheets: CalcTimesheet[];
  /** Approved entries from the previous period that fall in the first (partial) workweek. */
  priorEntries: Record<string, TimeEntry[]>;
  settings: OvertimeSettings;
  skippedEmployeeIds: string[];
}

export interface RunLine {
  employee_id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  pay_type: PayType;
  work_state: string | null;
  earning_code: EarningCode;
  hours: number | null;
  days: number | null;
  rate_cents: number;
  amount_cents: number;
}

export type WarningCode =
  | 'NO_APPROVED_TIMESHEET'
  | 'NO_COMPENSATION'
  | 'HOURS_OVER_24'
  | 'ENTRY_OUTSIDE_EMPLOYMENT';

export interface CalcWarning {
  employee_id: string;
  code: WarningCode;
  blocking: boolean;
  message: string;
}

export interface CodeTotal { hours: number; days: number; amount_cents: number }

export interface RunTotals {
  employee_count: number;
  gross_cents: number;
  by_code: Partial<Record<EarningCode, CodeTotal>>;
}

export interface CalcResult {
  lines: RunLine[];
  warnings: CalcWarning[];
  totals: RunTotals;
}
