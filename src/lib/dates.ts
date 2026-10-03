// Calendar dates are plain 'YYYY-MM-DD' strings. All math is done in UTC so the
// host time zone can never shift a date.
export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toUtc(d: ISODate): number {
  const m = ISO_RE.exec(d);
  if (!m) throw new Error(`Invalid date: ${d}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (fromUtc(t) !== d) throw new Error(`Invalid date: ${d}`);
  return t;
}

export function fromUtc(t: number): ISODate {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(d: ISODate): number {
  return new Date(toUtc(d)).getUTCDay();
}

export function isWeekday(d: ISODate): boolean {
  const w = dayOfWeek(d);
  return w !== 0 && w !== 6;
}

export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let t = toUtc(start), last = toUtc(end); t <= last; t += DAY_MS) out.push(fromUtc(t));
  return out;
}

export function weekStart(d: ISODate, startsOn: number): ISODate {
  return addDays(d, -((dayOfWeek(d) - startsOn + 7) % 7));
}

/** 'YYYY-MM' → first and last day of that month */
export function monthBounds(month: string): { start: ISODate; end: ISODate } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Invalid month: ${month}`);
  return { start: fromUtc(Date.UTC(y, mo - 1, 1)), end: fromUtc(Date.UTC(y, mo, 0)) };
}

export const maxDate = (a: ISODate, b: ISODate): ISODate => (a > b ? a : b);
export const minDate = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b);
