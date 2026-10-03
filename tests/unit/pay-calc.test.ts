import { describe, expect, it } from 'vitest';
import { calculateRun, splitOvertime } from '../../src/lib/pay-calc';
import { FEDERAL, WEEK_SEP_7, comp, days, emp, input, off, reg, single } from './fixtures';

const pick = (r: ReturnType<typeof calculateRun>) =>
  r.lines.map((l) => ({ code: l.earning_code, hours: l.hours, days: l.days, rate: l.rate_cents, amount: l.amount_cents }));

describe('salary', () => {
  it('pays annual / 12 for a full month', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], []));
    expect(pick(r)).toEqual([{ code: 'SAL', hours: null, days: 22, rate: 1_000_000, amount: 1_000_000 }]);
  });

  it('prorates a mid-month hire by weekdays', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], [], {}, emp('a', { hire_date: '2026-09-15' })));
    expect(pick(r)).toEqual([{ code: 'SAL', hours: null, days: 12, rate: 1_000_000, amount: 545_455 }]);
  });

  it('prorates a mid-month termination', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], [], {}, emp('a', { termination_date: '2026-09-04' })));
    expect(pick(r)).toEqual([{ code: 'SAL', hours: null, days: 4, rate: 1_000_000, amount: 181_818 }]);
  });

  it('splits a mid-month raise into two lines', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000), comp('a', 'salary', 13_200_000, '2026-09-16')], []));
    expect(pick(r)).toEqual([
      { code: 'SAL', hours: null, days: 11, rate: 1_000_000, amount: 500_000 },
      { code: 'SAL', hours: null, days: 11, rate: 1_100_000, amount: 550_000 },
    ]);
  });

  it('reports time off as unpaid informational lines', () => {
    const r = calculateRun(single([comp('a', 'salary', 12_000_000)], [off('PTO', '2026-09-03', 8), reg('2026-09-04', 8)]));
    expect(pick(r)).toEqual([
      { code: 'SAL', hours: null, days: 22, rate: 1_000_000, amount: 1_000_000 },
      { code: 'PTO', hours: 8, days: null, rate: 0, amount: 0 },
    ]);
  });
});

describe('hourly', () => {
  it('pays 40 hours straight time', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], days(WEEK_SEP_7, 8)));
    expect(pick(r)).toEqual([{ code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 }]);
  });

  it('moves hours past 40 in a week to overtime', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], days(WEEK_SEP_7, 9)));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 },
      { code: 'OT', hours: 5, days: null, rate: 3750, amount: 18_750 },
    ]);
  });

  it('applies daily OT and DT tiers', () => {
    const ca = { ...FEDERAL, ot_daily_threshold: 8, dt_daily_threshold: 12 };
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [reg('2026-09-07', 13)], { settings: ca }));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 8, days: null, rate: 2500, amount: 20_000 },
      { code: 'OT', hours: 4, days: null, rate: 3750, amount: 15_000 },
      { code: 'DT', hours: 1, days: null, rate: 5000, amount: 5_000 },
    ]);
  });

  it('does not double count daily OT toward the weekly threshold', () => {
    const ca = { ...FEDERAL, ot_daily_threshold: 8 };
    // 5 × 10h = 50h: 10h daily OT, 40h regular → no extra weekly OT
    const r = calculateRun(single([comp('a', 'hourly', 2500)], days(WEEK_SEP_7, 10), { settings: ca }));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 },
      { code: 'OT', hours: 10, days: null, rate: 3750, amount: 37_500 },
    ]);
  });

  it('counts prior-period hours in a workweek that spans the month start', () => {
    const r = calculateRun(single(
      [comp('a', 'hourly', 2500)],
      days(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'], 8),
      { priorEntries: { a: [reg('2026-08-31', 10)] } },
    ));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 30, days: null, rate: 2500, amount: 75_000 },
      { code: 'OT', hours: 2, days: null, rate: 3750, amount: 7_500 },
    ]);
  });

  it('pays time off at base rate and keeps it out of overtime', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [...days(WEEK_SEP_7, 8), off('PTO', '2026-09-12', 8)]));
    expect(pick(r)).toEqual([
      { code: 'PTO', hours: 8, days: null, rate: 2500, amount: 20_000 },
      { code: 'REG', hours: 40, days: null, rate: 2500, amount: 100_000 },
    ]);
  });

  it('uses the rate in effect on each day', () => {
    const r = calculateRun(single(
      [comp('a', 'hourly', 2500), comp('a', 'hourly', 3000, '2026-09-10')],
      days(WEEK_SEP_7, 8),
    ));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: 24, days: null, rate: 2500, amount: 60_000 },
      { code: 'REG', hours: 16, days: null, rate: 3000, amount: 48_000 },
    ]);
  });

  it('rounds half a cent up', () => {
    const r = calculateRun(single([comp('a', 'hourly', 1001)], [reg('2026-09-07', 0.5)]));
    expect(pick(r)).toEqual([{ code: 'REG', hours: 0.5, days: null, rate: 1001, amount: 501 }]);
  });
});

describe('daily', () => {
  it('pays days and half days at the day rate', () => {
    const r = calculateRun(single([comp('a', 'daily', 20_000)], [
      reg('2026-09-01', null, 1), reg('2026-09-02', null, 0.5), off('PTO', '2026-09-03', null, 1),
    ]));
    expect(pick(r)).toEqual([
      { code: 'REG', hours: null, days: 1.5, rate: 20_000, amount: 30_000 },
      { code: 'PTO', hours: null, days: 1, rate: 20_000, amount: 20_000 },
    ]);
  });

  it('adds a day-rate overtime premium only when enabled', () => {
    const entries = WEEK_SEP_7.map((d) => reg(d, 10, 1));
    expect(pick(calculateRun(single([comp('a', 'daily', 20_000)], entries)))).toEqual([
      { code: 'REG', hours: 50, days: 5, rate: 20_000, amount: 100_000 },
    ]);
    const r = calculateRun(single([comp('a', 'daily', 20_000)], entries, { settings: { ...FEDERAL, ot_applies_to_daily: true } }));
    expect(pick(r)).toEqual([
      { code: 'OT', hours: 10, days: null, rate: 2000, amount: 10_000 },
      { code: 'REG', hours: 50, days: 5, rate: 20_000, amount: 100_000 },
    ]);
  });
});

describe('warnings and inclusion', () => {
  it('blocks employees without an approved timesheet', () => {
    const r = calculateRun(input({
      employees: [emp('a')],
      compensation: [comp('a', 'hourly', 2500)],
      timesheets: [{ employee_id: 'a', status: 'submitted', entries: days(WEEK_SEP_7, 8) }],
    }));
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ employee_id: 'a', code: 'NO_APPROVED_TIMESHEET', blocking: true })]);
  });

  it('omits skipped employees without warning', () => {
    const r = calculateRun(input({ employees: [emp('a')], compensation: [comp('a', 'hourly', 2500)], skippedEmployeeIds: ['a'] }));
    expect(r).toMatchObject({ lines: [], warnings: [], totals: { employee_count: 0, gross_cents: 0 } });
  });

  it('ignores employees not employed during the period', () => {
    const r = calculateRun(input({
      employees: [emp('a', { termination_date: '2026-08-31' }), emp('b', { hire_date: '2026-10-01' })],
    }));
    expect(r).toMatchObject({ lines: [], warnings: [] });
  });

  it('blocks when compensation is missing for part of the period', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500, '2026-09-10')], days(WEEK_SEP_7, 8)));
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'NO_COMPENSATION', blocking: true })]);
  });

  it('ignores entries outside employment with a non-blocking warning', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [reg('2026-09-07', 8), reg('2026-09-20', 8)], {}, emp('a', { termination_date: '2026-09-15' })));
    expect(pick(r)).toEqual([{ code: 'REG', hours: 8, days: null, rate: 2500, amount: 20_000 }]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'ENTRY_OUTSIDE_EMPLOYMENT', blocking: false })]);
  });

  it('blocks a day with more than 24 hours', () => {
    const r = calculateRun(single([comp('a', 'hourly', 2500)], [reg('2026-09-07', 20), off('PTO', '2026-09-07', 8)]));
    expect(r.lines).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'HOURS_OVER_24', blocking: true })]);
  });
});

describe('totals', () => {
  it('sums by code and overall', () => {
    const r = calculateRun(input({
      employees: [emp('a'), emp('b')],
      compensation: [comp('a', 'hourly', 2500), comp('b', 'salary', 12_000_000)],
      timesheets: [
        { employee_id: 'a', status: 'approved', entries: days(WEEK_SEP_7, 9) },
        { employee_id: 'b', status: 'approved', entries: [] },
      ],
    }));
    expect(r.totals).toEqual({
      employee_count: 2,
      gross_cents: 1_118_750,
      by_code: {
        REG: { hours: 40, days: 0, amount_cents: 100_000 },
        OT: { hours: 5, days: 0, amount_cents: 18_750 },
        SAL: { hours: 0, days: 22, amount_cents: 1_000_000 },
      },
    });
  });
});

describe('splitOvertime', () => {
  it('assigns weekly OT to the latest days of the week', () => {
    const split = splitOvertime(
      [{ day: '2026-09-07', h100: 2000 }, { day: '2026-09-08', h100: 2500 }],
      [],
      { ...FEDERAL, ot_weekly_threshold: 40 },
    );
    expect(split).toEqual([
      { day: '2026-09-07', reg: 2000, ot: 0, dt: 0 },
      { day: '2026-09-08', reg: 2000, ot: 500, dt: 0 },
    ]);
  });
});
