import type { ISODate } from '../dates';
import type { EarningCode, RunLine, RunTotals } from '../types';

export const EXPORT_FIELDS = [
  'external_id', 'first_name', 'last_name', 'full_name', 'email', 'pay_type', 'work_state',
  'earning_code', 'hours', 'days', 'rate', 'amount', 'period_start', 'period_end', 'run_id',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export interface MappingColumn {
  header: string;
  field?: ExportField;
  /** per_employee only: take `field` from this employee's lines with this earning code */
  code?: EarningCode;
  /** fixed value, e.g. a company code */
  const?: string;
}

export interface MappingConfig {
  format: 'csv' | 'json';
  row_mode: 'per_line' | 'per_employee';
  date_format: 'YYYY-MM-DD' | 'MM/DD/YYYY';
  code_map: Partial<Record<EarningCode, string>>;
  columns: MappingColumn[];
}

export interface ExportRun {
  id: string;
  period_start: ISODate;
  period_end: ISODate;
  finalized_at: string | null;
  totals: RunTotals;
}

export interface Preset {
  key: string;
  name: string;
  note: string;
  config: MappingConfig;
}

export interface RenderedExport {
  filename: string;
  content_type: string;
  body: string;
  /** Pay on a line that no column carries (e.g. day-rate pay in an hours-only layout). */
  warnings: string[];
}

export type ExportLine = RunLine;
