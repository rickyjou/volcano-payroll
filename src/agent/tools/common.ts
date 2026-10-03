// Small helpers shared by the tool files: labels, amounts and period lookups.
import { eachDay, isWeekday, toUtc, type ISODate } from '../../lib/dates';
import { centsToDollars } from '../../lib/money';
import { currentPeriod, getPeriod, listPeriods } from '../queries';
import { Refusal, type Choice, type PeriodRef, type ToolCtx } from '../types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Fri Oct 3" */
export function dayLabel(d: ISODate): string {
  const t = new Date(toUtc(d));
  return `${DAY_NAMES[t.getUTCDay()]} ${MONTH_NAMES[t.getUTCMonth()]} ${t.getUTCDate()}`;
}

/** "October 2026" */
export const monthLabel = (d: ISODate): string => `${LONG_MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** "8h", "7.5h", "1 day", "½ day" */
export function amountLabel(a: { hours?: number | null; days?: number | null }): string {
  if (a.days != null) return a.days === 0.5 ? '½ day' : `${a.days} day${a.days === 1 ? '' : 's'}`;
  return `${Math.round((a.hours ?? 0) * 100) / 100}h`;
}

/** "$1,234.50" */
export function money(cents: number): string {
  const [whole, frac] = centsToDollars(cents).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

export const CONFIRM_CHOICES: Choice[] = [
  { id: 'confirm', label: 'Confirm', style: 'primary' },
  { id: 'cancel', label: 'Cancel', style: 'secondary' },
];
export const DANGER_CHOICES: Choice[] = [
  { id: 'confirm', label: 'Confirm', style: 'danger' },
  { id: 'cancel', label: 'Cancel', style: 'secondary' },
];

/** The period an argument names, or the user's current one when the argument is absent. */
export async function periodArg(ctx: ToolCtx, id: unknown): Promise<PeriodRef> {
  if (typeof id === 'string') return getPeriod(ctx.db, id);
  const p = currentPeriod(await listPeriods(ctx.db), ctx.today);
  if (!p) throw new Refusal('No pay period has been opened yet.');
  return p;
}

/** Weekdays in a period (up to `until`) with nothing logged on them. */
export function missingWeekdays(period: PeriodRef, logged: Set<ISODate>, until: ISODate): ISODate[] {
  const last = until < period.end_date ? until : period.end_date;
  if (last < period.start_date) return [];
  return eachDay(period.start_date, last).filter((d) => isWeekday(d) && !logged.has(d));
}

/** Turns a guard error ("CONFLICT:PERIOD_NOT_OPEN: ...") already mapped by HttpError into a sentence. */
export function sentence(message: string): string {
  const m = message.trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
