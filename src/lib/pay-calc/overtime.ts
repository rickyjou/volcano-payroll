import { weekStart, type ISODate } from '../dates';
import { toHundredths } from '../money';
import type { OvertimeSettings } from '../types';

/** Regular hours worked on one day, in hundredths. */
export interface DayHours { day: ISODate; h100: number }
export interface DaySplit { day: ISODate; reg: number; ot: number; dt: number }

const threshold = (x: number | null): number => (x == null ? Infinity : toHundredths(x));

/**
 * Splits worked hours into regular / overtime / double time.
 * 1. Daily tiers (if configured): above dt_daily_threshold → DT, above ot_daily_threshold → OT.
 * 2. Weekly: regular hours past ot_weekly_threshold within a workweek → OT, in date order.
 *    `prior` days (previous period, same workweek) count toward the weekly threshold
 *    but are not returned.
 */
export function splitOvertime(current: DayHours[], prior: DayHours[], s: OvertimeSettings): DaySplit[] {
  const dtT = threshold(s.dt_daily_threshold);
  const otT = threshold(s.ot_daily_threshold);
  const weeklyT = threshold(s.ot_weekly_threshold);
  const currentDays = new Set(current.map((d) => d.day));

  const all = [...prior, ...current]
    .map(({ day, h100 }) => {
      const dt = Math.max(0, h100 - dtT);
      const rest = h100 - dt;
      const ot = Math.max(0, rest - otT);
      return { day, reg: rest - ot, ot, dt };
    })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const regByWeek = new Map<ISODate, number>();
  for (const d of all) {
    const wk = weekStart(d.day, s.week_starts_on);
    const before = regByWeek.get(wk) ?? 0;
    const moved = Math.max(0, d.reg - Math.max(0, weeklyT - before));
    d.reg -= moved;
    d.ot += moved;
    regByWeek.set(wk, before + d.reg);
  }
  return all.filter((d) => currentDays.has(d.day));
}
