import { parseCsv } from './csv';
import { toUtc, type ISODate } from './dates';
import { dollarsToCents } from './money';
import type { PayType } from './types';

export type Role = 'employee' | 'manager' | 'admin';
export const ROLES: Role[] = ['employee', 'manager', 'admin'];
export const PAY_TYPES: PayType[] = ['salary', 'hourly', 'daily'];

export const IMPORT_COLUMNS = [
  'email', 'first_name', 'last_name', 'external_id', 'role', 'manager_email',
  'hire_date', 'work_state', 'pay_type', 'rate', 'effective_from',
] as const;
const REQUIRED = ['email', 'first_name', 'last_name', 'hire_date'] as const;

export interface ImportRow {
  line: number;
  email: string;
  first_name: string;
  last_name: string;
  external_id: string | null;
  role: Role;
  manager_email: string | null;
  hire_date: ISODate;
  work_state: string | null;
  pay_type: PayType | null;
  /** salary: annual; hourly: per hour; daily: per day */
  rate_cents: number | null;
  effective_from: ISODate | null;
}

export interface ImportError { line: number; message: string }

export const normalizeEmail = (s: string): string => s.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validDate(s: string): boolean {
  try { toUtc(s); return true; } catch { return false; }
}

export interface ImportRecord { line: number; values: Record<string, string> }

/** Splits a CSV into raw records keyed by lower-case column name. */
export function readEmployeeCsv(text: string): { records: ImportRecord[]; errors: ImportError[] } {
  let table: string[][];
  try { table = parseCsv(text); } catch (e) { return { records: [], errors: [{ line: 0, message: (e as Error).message }] }; }
  if (table.length === 0) return { records: [], errors: [{ line: 0, message: 'The file is empty' }] };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { records: [], errors: [{ line: 1, message: `Missing required column(s): ${missing.join(', ')}` }] };
  const unknown = header.filter((h) => h && !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) return { records: [], errors: [{ line: 1, message: `Unknown column(s): ${unknown.join(', ')}` }] };

  const records: ImportRecord[] = [];
  table.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    records.push({ line: i + 2, values: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])) });
  });
  return { records, errors: [] };
}

/** Validates raw records (in the browser for the preview, and again in the import function). */
export function validateRecords(records: ImportRecord[]): { rows: ImportRow[]; errors: ImportError[] } {
  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];
  const seen = new Map<string, number>();

  for (const { line, values } of records) {
    const get = (col: string) => String(values[col] ?? '').trim();
    const opt = (col: string) => get(col) || null;
    const errs: string[] = [];

    const email = normalizeEmail(get('email'));
    if (!EMAIL_RE.test(email)) errs.push(`invalid email "${get('email')}"`);
    else if (seen.has(email)) errs.push(`duplicate email ${email} (also on line ${seen.get(email)})`);
    else seen.set(email, line);

    if (!get('first_name')) errs.push('first_name is required');
    if (!get('last_name')) errs.push('last_name is required');

    const role = (get('role').toLowerCase() || 'employee') as Role;
    if (!ROLES.includes(role)) errs.push(`role must be one of ${ROLES.join(', ')}`);

    const manager = opt('manager_email') ? normalizeEmail(get('manager_email')) : null;
    if (manager && manager === email) errs.push('an employee cannot be their own manager');

    const hire = get('hire_date');
    if (!validDate(hire)) errs.push(`hire_date must be YYYY-MM-DD (got "${hire}")`);

    const state = opt('work_state')?.toUpperCase() ?? null;
    if (state && !/^[A-Z]{2}$/.test(state)) errs.push(`work_state must be a 2-letter code (got "${state}")`);

    const payType = (get('pay_type').toLowerCase() || null) as PayType | null;
    const rateRaw = get('rate');
    let rate: number | null = null;
    if (payType && !PAY_TYPES.includes(payType)) errs.push(`pay_type must be one of ${PAY_TYPES.join(', ')}`);
    if (!!payType !== !!rateRaw) errs.push('pay_type and rate must be given together');
    if (rateRaw) {
      try { rate = dollarsToCents(rateRaw); } catch { errs.push(`rate must be a dollar amount (got "${rateRaw}")`); }
      if (rate === 0) errs.push('rate must be greater than zero');
    }
    const eff = opt('effective_from');
    if (eff && !validDate(eff)) errs.push(`effective_from must be YYYY-MM-DD (got "${eff}")`);

    if (errs.length) { errors.push(...errs.map((message) => ({ line, message }))); continue; }
    rows.push({
      line, email, first_name: get('first_name'), last_name: get('last_name'),
      external_id: opt('external_id'), role, manager_email: manager, hire_date: hire, work_state: state,
      pay_type: payType, rate_cents: rate, effective_from: payType ? (eff ?? hire) : null,
    });
  }
  return { rows, errors };
}

/** Parses and validates an employee CSV. Rows with any error are left out of `rows`. */
export function parseEmployeeCsv(text: string): { rows: ImportRow[]; errors: ImportError[]; records: ImportRecord[] } {
  const read = readEmployeeCsv(text);
  if (read.errors.length) return { rows: [], errors: read.errors, records: [] };
  return { ...validateRecords(read.records), records: read.records };
}
