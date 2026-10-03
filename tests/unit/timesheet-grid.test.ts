import { describe, expect, it } from 'vitest';
import { cellKey, cellsFromEntries, gridDays, parseDays, parseHours, planSave, totalsByCode, type GridEntry } from '../../src/lib/timesheet-grid';

const saved: GridEntry[] = [
  { id: 'e1', work_date: '2026-09-01', earning_code: 'REG', hours: 8, days: null },
  { id: 'e2', work_date: '2026-09-02', earning_code: 'REG', hours: 8, days: null },
  { id: 'e3', work_date: '2026-09-03', earning_code: 'PTO', hours: 8, days: null },
];

describe('gridDays', () => {
  it('labels weekdays and weekends', () => {
    expect(gridDays('2026-09-04', '2026-09-06')).toEqual([
      { date: '2026-09-04', weekday: 'Fri', weekend: false },
      { date: '2026-09-05', weekday: 'Sat', weekend: true },
      { date: '2026-09-06', weekday: 'Sun', weekend: true },
    ]);
  });
});

describe('parsing', () => {
  it('parses hours', () => {
    expect(parseHours('')).toEqual({ ok: true, value: null });
    expect(parseHours('0')).toEqual({ ok: true, value: null });
    expect(parseHours(' 7.5 ')).toEqual({ ok: true, value: 7.5 });
    expect(parseHours('24')).toEqual({ ok: true, value: 24 });
    expect(parseHours('24.5')).toEqual({ ok: false, error: 'At most 24 hours in a day' });
    expect(parseHours('8h')).toEqual({ ok: false, error: 'Enter hours like 8 or 7.5' });
    expect(parseHours('-1')).toEqual({ ok: false, error: 'Enter hours like 8 or 7.5' });
    expect(parseHours('7.555')).toEqual({ ok: false, error: 'Enter hours like 8 or 7.5' });
  });
  it('parses days', () => {
    expect(parseDays('1')).toEqual({ ok: true, value: 1 });
    expect(parseDays('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseDays('')).toEqual({ ok: true, value: null });
    expect(parseDays('2')).toEqual({ ok: false, error: 'Choose a full or half day' });
  });
});

describe('planSave', () => {
  it('inserts, updates and deletes only what changed', () => {
    const cells = cellsFromEntries(saved);
    cells[cellKey('2026-09-01', 'REG')] = { hours: '9', days: '' };   // update
    cells[cellKey('2026-09-02', 'REG')] = { hours: '', days: '' };    // delete
    cells[cellKey('2026-09-04', 'SICK')] = { hours: '4', days: '' };  // insert
    expect(planSave(saved, cells, 'hourly', false)).toEqual({
      inserts: [{ work_date: '2026-09-04', earning_code: 'SICK', hours: 4, days: null }],
      updates: [{ id: 'e1', hours: 9, days: null }],
      deletes: ['e2'],
      errors: {},
    });
  });

  it('reports invalid cells and leaves them untouched', () => {
    const cells = { [cellKey('2026-09-01', 'REG')]: { hours: '30', days: '' } };
    expect(planSave(saved, cells, 'hourly', false)).toEqual({
      inserts: [], updates: [], deletes: [], errors: { '2026-09-01|REG': 'At most 24 hours in a day' },
    });
  });

  it('stores days for daily employees and drops hours unless day-rate OT is on', () => {
    const cells = { [cellKey('2026-09-07', 'REG')]: { hours: '10', days: '1' } };
    expect(planSave([], cells, 'daily', false).inserts).toEqual([{ work_date: '2026-09-07', earning_code: 'REG', hours: null, days: 1 }]);
    expect(planSave([], cells, 'daily', true).inserts).toEqual([{ work_date: '2026-09-07', earning_code: 'REG', hours: 10, days: 1 }]);
  });

  it('does not save hours without a day for daily employees', () => {
    const cells = { [cellKey('2026-09-07', 'REG')]: { hours: '10', days: '' } };
    expect(planSave([], cells, 'daily', true).inserts).toEqual([]);
  });
});

describe('totalsByCode', () => {
  it('sums hours and days without float drift', () => {
    const t = totalsByCode([
      { work_date: '2026-09-01', earning_code: 'REG', hours: 0.1, days: null },
      { work_date: '2026-09-02', earning_code: 'REG', hours: 0.2, days: null },
    ]);
    expect(t.REG).toEqual({ hours: 0.3, days: 0 });
  });
});
