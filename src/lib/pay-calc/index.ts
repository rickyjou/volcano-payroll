import { eachDay, isWeekday, maxDate, minDate, weekStart, type ISODate } from '../dates';
import { divRoundHalfUp, toHundredths, toTenths, toThousandths } from '../money';
import type {
  CalcEmployee, CalcInput, CalcResult, CalcWarning, CompSegment, EarningCode,
  OvertimeSettings, RunLine, RunTotals, TimeEntry,
} from '../types';
import { LineAccumulator } from './lines';
import { splitOvertime, type DayHours } from './overtime';

export { splitOvertime } from './overtime';

/** The compensation in effect on `day` (latest effective_from ≤ day). */
export function compensationOn(comp: CompSegment[], employeeId: string, day: ISODate): CompSegment | null {
  let best: CompSegment | null = null;
  for (const c of comp) {
    if (c.employee_id !== employeeId || c.effective_from > day) continue;
    if (!best || c.effective_from > best.effective_from) best = c;
  }
  return best;
}

/** Days in the period on which the employee was employed. */
export function employmentDays(emp: CalcEmployee, period: { start: ISODate; end: ISODate }): ISODate[] {
  const start = maxDate(period.start, emp.hire_date);
  const end = emp.termination_date ? minDate(period.end, emp.termination_date) : period.end;
  return start > end ? [] : eachDay(start, end);
}

const name = (e: CalcEmployee) => `${e.first_name} ${e.last_name}`;

export function calculateRun(input: CalcInput): CalcResult {
  const { period, settings } = input;
  const skipped = new Set(input.skippedEmployeeIds);
  const periodWorkdays = eachDay(period.start, period.end).filter(isWeekday).length;
  const lines: RunLine[] = [];
  const warnings: CalcWarning[] = [];
  let employeeCount = 0;

  for (const emp of input.employees) {
    const days = employmentDays(emp, period);
    if (days.length === 0 || skipped.has(emp.id)) continue;

    const warn = (code: CalcWarning['code'], blocking: boolean, message: string) =>
      warnings.push({ employee_id: emp.id, code, blocking, message });

    const ts = input.timesheets.find((t) => t.employee_id === emp.id);
    if (!ts || ts.status !== 'approved') {
      warn('NO_APPROVED_TIMESHEET', true, `${name(emp)} has no approved timesheet`);
      continue;
    }

    const compByDay = new Map<ISODate, CompSegment | null>(
      days.map((d) => [d, compensationOn(input.compensation, emp.id, d)]),
    );
    const missingComp = days.filter((d) => !compByDay.get(d));
    if (missingComp.length > 0) {
      warn('NO_COMPENSATION', true, `${name(emp)} has no compensation on ${missingComp[0]}${missingComp.length > 1 ? ` (+${missingComp.length - 1} more days)` : ''}`);
      continue;
    }

    const entries: TimeEntry[] = [];
    for (const e of ts.entries) {
      if (compByDay.has(e.work_date)) entries.push(e);
      else warn('ENTRY_OUTSIDE_EMPLOYMENT', false, `${name(emp)}: entry on ${e.work_date} is outside employment dates and was ignored`);
    }

    const hoursPerDay = new Map<ISODate, number>();
    for (const e of entries) hoursPerDay.set(e.work_date, (hoursPerDay.get(e.work_date) ?? 0) + toHundredths(e.hours ?? 0));
    const overDays = [...hoursPerDay].filter(([, h]) => h > 2400).map(([d]) => d);
    if (overDays.length > 0) {
      warn('HOURS_OVER_24', true, `${name(emp)} has more than 24 hours on ${overDays.join(', ')}`);
      continue;
    }

    employeeCount += 1;
    const acc = new LineAccumulator(emp);
    addSalary(acc, days, compByDay, periodWorkdays);
    addEntries(acc, entries, compByDay);
    addHourlyOvertime(acc, emp.id, entries, input.priorEntries[emp.id] ?? [], input.compensation, compByDay, settings);
    if (settings.ot_applies_to_daily) {
      addDailyOvertime(acc, emp.id, entries, input.priorEntries[emp.id] ?? [], input.compensation, compByDay, settings);
    }
    lines.push(...acc.lines());
  }

  return { lines, warnings, totals: totalsOf(lines, employeeCount) };
}

/** One SAL line per compensation segment: annual / 12 × segment workdays / period workdays. */
function addSalary(acc: LineAccumulator, days: ISODate[], compByDay: Map<ISODate, CompSegment | null>, periodWorkdays: number) {
  const workdaysByComp = new Map<CompSegment, number>();
  for (const d of days) {
    const c = compByDay.get(d)!;
    if (c.pay_type !== 'salary') continue;
    workdaysByComp.set(c, (workdaysByComp.get(c) ?? 0) + (isWeekday(d) ? 1 : 0));
  }
  for (const [c, workdays] of workdaysByComp) {
    if (workdays === 0) continue;
    acc.addFixed({
      code: 'SAL',
      payType: 'salary',
      rate: divRoundHalfUp(c.rate_cents, 12),
      amount: divRoundHalfUp(c.rate_cents * workdays, 12 * periodWorkdays),
      h100: null,
      d10: workdays * 10,
    });
  }
}

/** Time off for everyone, and day-rate pay for daily employees. Hourly REG is handled with overtime. */
function addEntries(acc: LineAccumulator, entries: TimeEntry[], compByDay: Map<ISODate, CompSegment | null>) {
  for (const e of entries) {
    const c = compByDay.get(e.work_date)!;
    const h100 = toHundredths(e.hours ?? 0);
    const d10 = toTenths(e.days ?? 0);
    if (c.pay_type === 'salary') {
      if (e.earning_code !== 'REG') acc.addInfo(e.earning_code, 'salary', h100, d10);
    } else if (c.pay_type === 'hourly') {
      if (e.earning_code !== 'REG') acc.addHours(e.earning_code, 'hourly', c.rate_cents, 1000, h100);
    } else {
      acc.addDays(e.earning_code, 'daily', c.rate_cents, d10, h100);
    }
  }
}

function regHoursOn(entries: TimeEntry[], payType: 'hourly' | 'daily', comp: (d: ISODate) => CompSegment | null): DayHours[] {
  return entries
    .filter((e) => e.earning_code === 'REG' && e.hours != null && comp(e.work_date)?.pay_type === payType)
    .map((e) => ({ day: e.work_date, h100: toHundredths(e.hours!) }));
}

function addHourlyOvertime(
  acc: LineAccumulator, employeeId: string, entries: TimeEntry[], prior: TimeEntry[],
  allComp: CompSegment[], compByDay: Map<ISODate, CompSegment | null>, s: OvertimeSettings,
) {
  const current = regHoursOn(entries, 'hourly', (d) => compByDay.get(d) ?? null);
  if (current.length === 0) return;
  const priorHours = regHoursOn(prior, 'hourly', (d) => compensationOn(allComp, employeeId, d));
  const otM = toThousandths(s.ot_multiplier);
  const dtM = toThousandths(s.dt_multiplier);
  for (const d of splitOvertime(current, priorHours, s)) {
    const rate = compByDay.get(d.day)!.rate_cents;
    acc.addHours('REG', 'hourly', rate, 1000, d.reg);
    acc.addHours('OT', 'hourly', rate, otM, d.ot);
    acc.addHours('DT', 'hourly', rate, dtM, d.dt);
  }
}

/**
 * Day-rate overtime (FLSA): regular rate = week's day-rate pay / week's hours;
 * premium = (multiplier − 1) × regular rate × hours over the weekly threshold.
 * Only hours past the threshold that fall in this period are paid here.
 */
function addDailyOvertime(
  acc: LineAccumulator, employeeId: string, entries: TimeEntry[], prior: TimeEntry[],
  allComp: CompSegment[], compByDay: Map<ISODate, CompSegment | null>, s: OvertimeSettings,
) {
  if (s.ot_weekly_threshold == null) return;
  const threshold = toHundredths(s.ot_weekly_threshold);
  const premiumM = toThousandths(s.ot_multiplier) - 1000;
  const currentDays = new Set(entries.map((e) => e.work_date));
  const rows = [...prior, ...entries]
    .filter((e) => e.earning_code === 'REG')
    .map((e) => {
      const c = currentDays.has(e.work_date) ? compByDay.get(e.work_date) ?? null : compensationOn(allComp, employeeId, e.work_date);
      return { e, c };
    })
    .filter((r): r is { e: TimeEntry; c: CompSegment } => r.c?.pay_type === 'daily')
    .sort((a, b) => (a.e.work_date < b.e.work_date ? -1 : 1));

  const weeks = new Map<ISODate, typeof rows>();
  for (const r of rows) {
    const wk = weekStart(r.e.work_date, s.week_starts_on);
    weeks.set(wk, [...(weeks.get(wk) ?? []), r]);
  }
  for (const week of weeks.values()) {
    const pay = week.reduce((sum, r) => sum + divRoundHalfUp(toTenths(r.e.days ?? 0) * r.c.rate_cents, 10), 0);
    const hours = week.reduce((sum, r) => sum + toHundredths(r.e.hours ?? 0), 0);
    if (hours <= threshold) continue;
    let cum = 0;
    let otInPeriod = 0;
    for (const r of week) {
      const h = toHundredths(r.e.hours ?? 0);
      const over = Math.max(0, cum + h - Math.max(threshold, cum));
      if (currentDays.has(r.e.work_date)) otInPeriod += over;
      cum += h;
    }
    if (otInPeriod === 0) continue;
    acc.addFixed({
      code: 'OT',
      payType: 'daily',
      rate: divRoundHalfUp(pay * 100, hours),
      amount: divRoundHalfUp(pay * otInPeriod * premiumM, hours * 1000),
      h100: otInPeriod,
      d10: null,
    });
  }
}

function totalsOf(lines: RunLine[], employeeCount: number): RunTotals {
  const by: RunTotals['by_code'] = {};
  let gross = 0;
  for (const l of lines) {
    const t = (by[l.earning_code as EarningCode] ??= { hours: 0, days: 0, amount_cents: 0 });
    t.hours = (toHundredths(t.hours) + toHundredths(l.hours ?? 0)) / 100;
    t.days = (toTenths(t.days) + toTenths(l.days ?? 0)) / 10;
    t.amount_cents += l.amount_cents;
    gross += l.amount_cents;
  }
  return { employee_count: employeeCount, gross_cents: gross, by_code: by };
}
