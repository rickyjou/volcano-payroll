import { guardFormula, toCsv } from '../csv';
import type { ISODate } from '../dates';
import { centsToDollars, toHundredths } from '../money';
import { EARNING_CODES, type EarningCode } from '../types';
import {
  EXPORT_FIELDS, type ExportField, type ExportLine, type ExportRun, type MappingColumn,
  type MappingConfig, type RenderedExport,
} from './types';

export * from './types';
export { PRESETS, findPreset } from './presets';

const TEXT_FIELDS = new Set<ExportField>(['external_id', 'first_name', 'last_name', 'full_name', 'email', 'work_state', 'earning_code', 'pay_type']);
const QUANTITY_FIELDS = new Set<ExportField>(['hours', 'days', 'amount']);

export function validateMapping(c: MappingConfig): string[] {
  const errors: string[] = [];
  if (!['csv', 'json'].includes(c.format)) errors.push(`Unknown format "${c.format}"`);
  if (!['per_line', 'per_employee'].includes(c.row_mode)) errors.push(`Unknown row mode "${c.row_mode}"`);
  if (!['YYYY-MM-DD', 'MM/DD/YYYY'].includes(c.date_format)) errors.push(`Unknown date format "${c.date_format}"`);
  for (const [code, label] of Object.entries(c.code_map ?? {})) {
    if (!EARNING_CODES.includes(code as EarningCode)) errors.push(`Unknown earning code "${code}" in code map`);
    if (typeof label !== 'string' || label.trim() === '') errors.push(`Code map label for ${code} is empty`);
  }
  if (c.format === 'json') return errors;
  if (!Array.isArray(c.columns) || c.columns.length === 0) errors.push('Add at least one column');
  (c.columns ?? []).forEach((col, i) => {
    const n = `Column ${i + 1}`;
    if (!col.header?.trim()) errors.push(`${n}: header is required`);
    const hasField = col.field != null;
    const hasConst = col.const != null;
    if (hasField === hasConst) errors.push(`${n}: set exactly one of field or constant`);
    if (hasField && !EXPORT_FIELDS.includes(col.field!)) errors.push(`${n}: unknown field "${col.field}"`);
    if (col.code != null) {
      if (c.row_mode !== 'per_employee') errors.push(`${n}: earning code columns need per-employee rows`);
      if (!EARNING_CODES.includes(col.code)) errors.push(`${n}: unknown earning code "${col.code}"`);
      if (hasField && !['hours', 'days', 'amount', 'rate'].includes(col.field!)) errors.push(`${n}: earning code columns must use hours, days, amount, or rate`);
    }
    if (c.row_mode === 'per_employee' && col.field === 'earning_code') errors.push(`${n}: earning_code needs per-line rows`);
  });
  return errors;
}

function formatDate(d: ISODate, f: MappingConfig['date_format']): string {
  if (f === 'YYYY-MM-DD') return d;
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

const qty = (x: number | null): string => (x == null ? '' : (toHundredths(x) / 100).toFixed(2));

const byEmployee = (a: ExportLine, b: ExportLine): number =>
  a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name) || a.employee_id.localeCompare(b.employee_id);

const byLine = (a: ExportLine, b: ExportLine): number =>
  byEmployee(a, b) || EARNING_CODES.indexOf(a.earning_code) - EARNING_CODES.indexOf(b.earning_code) || a.rate_cents - b.rate_cents;

/** Value of `field` for one line (or the employee part of a group). */
function lineValue(field: ExportField, l: ExportLine, run: ExportRun, c: MappingConfig): string {
  switch (field) {
    case 'external_id': return l.external_id ?? '';
    case 'first_name': return l.first_name;
    case 'last_name': return l.last_name;
    case 'full_name': return `${l.first_name} ${l.last_name}`;
    case 'email': return l.email;
    case 'pay_type': return l.pay_type;
    case 'work_state': return l.work_state ?? '';
    case 'earning_code': return c.code_map[l.earning_code] ?? l.earning_code;
    case 'hours': return qty(l.hours);
    case 'days': return qty(l.days);
    case 'rate': return centsToDollars(l.rate_cents);
    case 'amount': return centsToDollars(l.amount_cents);
    case 'period_start': return formatDate(run.period_start, c.date_format);
    case 'period_end': return formatDate(run.period_end, c.date_format);
    case 'run_id': return run.id;
  }
}

/** Sum of a quantity field over lines; '' when no line has a value. */
function aggregate(field: ExportField, lines: ExportLine[]): string {
  if (field === 'amount') return lines.length ? centsToDollars(lines.reduce((s, l) => s + l.amount_cents, 0)) : '';
  if (field === 'rate') return lines.length ? centsToDollars(lines[0].rate_cents) : '';
  const vals = lines.map((l) => (field === 'hours' ? l.hours : l.days)).filter((v): v is number => v != null);
  return vals.length ? qty(vals.reduce((s, v) => (toHundredths(s) + toHundredths(v)) / 100, 0)) : '';
}

function cell(col: MappingColumn, value: string): string {
  const isText = col.const != null || TEXT_FIELDS.has(col.field!);
  return isText ? guardFormula(value) : value;
}

function csvRows(run: ExportRun, lines: ExportLine[], c: MappingConfig): string[][] {
  const header = c.columns.map((col) => col.header);
  if (c.row_mode === 'per_line') {
    return [header, ...[...lines].sort(byLine).map((l) =>
      c.columns.map((col) => cell(col, col.const ?? lineValue(col.field!, l, run, c))))];
  }
  const groups = new Map<string, ExportLine[]>();
  for (const l of [...lines].sort(byLine)) groups.set(l.employee_id, [...(groups.get(l.employee_id) ?? []), l]);
  const rows = [...groups.values()].map((group) =>
    c.columns.map((col) => {
      if (col.const != null) return cell(col, col.const);
      const field = col.field!;
      if (col.code) return aggregate(field, group.filter((l) => l.earning_code === col.code));
      if (QUANTITY_FIELDS.has(field)) return aggregate(field, group);
      return cell(col, lineValue(field, group[0], run, c));
    }));
  return [header, ...rows];
}

export function render(run: ExportRun, lines: ExportLine[], c: MappingConfig, mappingKey: string): RenderedExport {
  const errors = validateMapping(c);
  if (errors.length) throw new Error(`Invalid mapping: ${errors.join('; ')}`);
  const base = `payroll-${run.period_start.slice(0, 7)}-${mappingKey.replace(/[^a-z0-9_-]/gi, '_')}`;
  if (c.format === 'json') {
    const body = JSON.stringify({
      schema_version: 1,
      run: { id: run.id, period_start: run.period_start, period_end: run.period_end, finalized_at: run.finalized_at, totals: run.totals },
      lines: [...lines].sort(byLine).map((l) => ({
        employee_id: l.employee_id, external_id: l.external_id, first_name: l.first_name, last_name: l.last_name,
        email: l.email, pay_type: l.pay_type, work_state: l.work_state, earning_code: l.earning_code,
        earning_label: c.code_map[l.earning_code] ?? l.earning_code,
        hours: l.hours, days: l.days, rate_cents: l.rate_cents, amount_cents: l.amount_cents,
      })),
    }, null, 2);
    return { filename: `${base}.json`, content_type: 'application/json', body };
  }
  return { filename: `${base}.csv`, content_type: 'text/csv; charset=utf-8', body: toCsv(csvRows(run, lines, c)) };
}
