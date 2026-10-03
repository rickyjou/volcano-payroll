import { dayOfWeek, eachDay, isWeekday, type ISODate } from './dates';
import { toHundredths } from './money';
import { ENTRY_CODES, type EntryCode, type PayType } from './types';

export interface GridEntry {
  id?: string;
  work_date: ISODate;
  earning_code: EntryCode;
  hours: number | null;
  days: number | null;
}

/** What the employee typed, keyed by `${date}|${code}`. */
export type CellValues = Record<string, { hours: string; days: string }>;

export const cellKey = (date: ISODate, code: EntryCode): string => `${date}|${code}`;

export interface GridDay { date: ISODate; weekday: string; weekend: boolean }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function gridDays(start: ISODate, end: ISODate): GridDay[] {
  return eachDay(start, end).map((date) => ({ date, weekday: WEEKDAYS[dayOfWeek(date)], weekend: !isWeekday(date) }));
}

export function cellsFromEntries(entries: GridEntry[]): CellValues {
  const out: CellValues = {};
  for (const e of entries) {
    out[cellKey(e.work_date, e.earning_code)] = {
      hours: e.hours == null ? '' : String(e.hours),
      days: e.days == null ? '' : String(e.days),
    };
  }
  return out;
}

export type Parsed = { ok: true; value: number | null } | { ok: false; error: string };

/** Hours: blank/0 → none; otherwise 0.01–24 with at most two decimals. */
export function parseHours(raw: string): Parsed {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'Enter hours like 8 or 7.5' };
  const n = Number(s);
  if (n > 24) return { ok: false, error: 'At most 24 hours in a day' };
  return { ok: true, value: n === 0 ? null : n };
}

/** Days: blank/0 → none; 0.5 or 1. */
export function parseDays(raw: string): Parsed {
  const s = raw.trim();
  if (s === '' || s === '0') return { ok: true, value: null };
  if (s === '0.5' || s === '1') return { ok: true, value: Number(s) };
  return { ok: false, error: 'Choose a full or half day' };
}

/** Which inputs a pay type gets. Daily REG also takes hours when day-rate overtime is on. */
export function inputsFor(payType: PayType, code: EntryCode, dailyHours: boolean): { hours: boolean; days: boolean } {
  if (payType !== 'daily') return { hours: true, days: false };
  return { hours: dailyHours && code === 'REG', days: true };
}

export interface SavePlan {
  inserts: GridEntry[];
  updates: { id: string; hours: number | null; days: number | null }[];
  deletes: string[];
  errors: Record<string, string>;
}

/** Diff the typed cells against the saved entries. Invalid cells are reported, never saved. */
export function planSave(existing: GridEntry[], cells: CellValues, payType: PayType, dailyHours: boolean): SavePlan {
  const plan: SavePlan = { inserts: [], updates: [], deletes: [], errors: {} };
  const byKey = new Map(existing.map((e) => [cellKey(e.work_date, e.earning_code), e]));
  const keys = new Set([...byKey.keys(), ...Object.keys(cells)]);
  for (const key of keys) {
    const [date, code] = key.split('|') as [ISODate, EntryCode];
    if (!ENTRY_CODES.includes(code)) continue;
    const prev = byKey.get(key);
    const cell = cells[key];
    let hours: number | null = prev?.hours ?? null;
    let days: number | null = prev?.days ?? null;
    if (cell) {
      const want = inputsFor(payType, code, dailyHours);
      const h = want.hours ? parseHours(cell.hours) : ({ ok: true, value: null } as Parsed);
      const d = want.days ? parseDays(cell.days) : ({ ok: true, value: null } as Parsed);
      if (!h.ok || !d.ok) { plan.errors[key] = !h.ok ? h.error : (d as { error: string }).error; continue; }
      hours = h.value;
      days = d.value;
      if (payType === 'daily' && days == null) hours = null;
    }
    const empty = hours == null && days == null;
    if (!prev) {
      if (!empty) plan.inserts.push({ work_date: date, earning_code: code, hours, days });
    } else if (empty) {
      plan.deletes.push(prev.id!);
    } else if (hours !== prev.hours || days !== prev.days) {
      plan.updates.push({ id: prev.id!, hours, days });
    }
  }
  return plan;
}

export function totalsByCode(entries: GridEntry[]): Record<EntryCode, { hours: number; days: number }> {
  const out = Object.fromEntries(ENTRY_CODES.map((c) => [c, { hours: 0, days: 0 }])) as Record<EntryCode, { hours: number; days: number }>;
  for (const e of entries) {
    out[e.earning_code].hours = (toHundredths(out[e.earning_code].hours) + toHundredths(e.hours ?? 0)) / 100;
    out[e.earning_code].days += e.days ?? 0;
  }
  return out;
}
