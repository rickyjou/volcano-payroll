import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, eachDay, isWeekday, monthBounds, toUtc, weekStart } from '../../src/lib/dates';
import { centsToDollars, divRoundHalfUp, dollarsToCents } from '../../src/lib/money';

describe('dates', () => {
  it('knows 2026-09-01 is a Tuesday', () => {
    expect(dayOfWeek('2026-09-01')).toBe(2);
  });
  it('rejects impossible dates', () => {
    expect(() => toUtc('2026-02-30')).toThrow('Invalid date');
    expect(() => toUtc('2026-9-1')).toThrow('Invalid date');
  });
  it('adds days across month and year ends', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('lists every day inclusive', () => {
    expect(eachDay('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  it('counts 22 weekdays in September 2026', () => {
    const { start, end } = monthBounds('2026-09');
    expect([start, end]).toEqual(['2026-09-01', '2026-09-30']);
    expect(eachDay(start, end).filter(isWeekday)).toHaveLength(22);
  });
  it('handles February in a leap year', () => {
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
  it('finds the workweek start', () => {
    expect(weekStart('2026-09-01', 0)).toBe('2026-08-30'); // Sunday-start week
    expect(weekStart('2026-09-01', 1)).toBe('2026-08-31'); // Monday-start week
    expect(weekStart('2026-08-30', 0)).toBe('2026-08-30');
  });
});

describe('money', () => {
  it('rounds half up', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(4, 3)).toBe(1);
    expect(divRoundHalfUp(5005, 10)).toBe(501);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
  });
  it('is exact for large values', () => {
    expect(divRoundHalfUp(144_000_000, 264)).toBe(545455);
    expect(divRoundHalfUp(9_007_199_254_740_990, 3)).toBe(3_002_399_751_580_330);
  });
  it('formats and parses dollars', () => {
    expect(centsToDollars(123456)).toBe('1234.56');
    expect(centsToDollars(5)).toBe('0.05');
    expect(centsToDollars(-250)).toBe('-2.50');
    expect(dollarsToCents('$1,234.5')).toBe(123450);
    expect(dollarsToCents('40')).toBe(4000);
    expect(() => dollarsToCents('12.345')).toThrow('Invalid amount');
    expect(() => dollarsToCents('-5')).toThrow('Invalid amount');
  });
});
