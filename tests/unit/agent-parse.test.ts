import { describe, expect, it } from 'vitest';
import { isAdditive, parseAmount, parseCode, parseDay, parseFormat, parseMonth } from '../../src/agent/parse';

const TODAY = '2026-10-07'; // a Wednesday

describe('parseAmount', () => {
  it.each([
    ['log 8 hours for today', { hours: 8 }],
    ['7.5h yesterday', { hours: 7.5 }],
    ['worked 8:30 on friday', { hours: 8.5 }],
    ['add 2 more hours', { hours: 2 }],
    ['half day yesterday', { days: 0.5 }],
    ['log a full day today', { days: 1 }],
    ['1 day of PTO', { days: 1 }],
    ['8 hours on the 12th', { hours: 8 }],
    ['8 on oct 3', { hours: 8 }],
    ['6h on 10/2', { hours: 6 }],
  ])('%s', (text, expected) => {
    expect(parseAmount(text)).toEqual(expected);
  });
  it('finds nothing when no amount is given', () => {
    expect(parseAmount('log time for the 12th')).toBeNull();
    expect(parseAmount('submit my timesheet')).toBeNull();
  });
});

describe('parseDay', () => {
  it.each([
    ['log 8 hours for today', '2026-10-07'],
    ['8h yesterday', '2026-10-06'],
    ['friday', '2026-10-02'],
    ['last wednesday', '2026-09-30'],
    ['on monday', '2026-10-05'],
    ['the 12th', '2026-10-12'],
    ['oct 3', '2026-10-03'],
    ['3 october', '2026-10-03'],
    ['2026-09-30', '2026-09-30'],
    ['on 10/2', '2026-10-02'],
  ])('%s', (text, expected) => {
    expect(parseDay(text, TODAY)).toBe(expected);
  });
  it('crosses month and year ends', () => {
    expect(parseDay('yesterday', '2026-10-01')).toBe('2026-09-30');
    expect(parseDay('yesterday', '2027-01-01')).toBe('2026-12-31');
  });
  it('rejects impossible dates and finds nothing when none is named', () => {
    expect(parseDay('feb 30', TODAY)).toBeNull();
    expect(parseDay('submit my timesheet', TODAY)).toBeNull();
  });
});

describe('parseMonth', () => {
  it.each([
    ['open this month', '2026-10'],
    ['open next month', '2026-11'],
    ['lock last month', '2026-09'],
    ['generate november', '2026-11'],
    ['export dec 2025', '2025-12'],
    ['open 2027-01', '2027-01'],
    ['open may', '2026-05'],
  ])('%s', (text, expected) => {
    expect(parseMonth(text, TODAY)).toBe(expected);
  });
  it('rolls over the year', () => {
    expect(parseMonth('next month', '2026-12-15')).toBe('2027-01');
  });
  it('does not read the verb "may" as a month', () => {
    expect(parseMonth('may I see my pay', TODAY)).toBeNull();
  });
});

describe('codes, additions and formats', () => {
  it('reads earning codes, defaulting to REG', () => {
    expect(parseCode('I was out sick today')).toBe('SICK');
    expect(parseCode('take friday as vacation')).toBe('PTO');
    expect(parseCode('holiday on monday')).toBe('HOL');
    expect(parseCode('log 8 hours')).toBe('REG');
  });
  it('tells adding apart from setting', () => {
    expect(isAdditive('add 2 more hours today')).toBe(true);
    expect(isAdditive('log another hour')).toBe(true);
    expect(isAdditive('log 8 hours today')).toBe(false);
    expect(isAdditive('make it 8 more like, replace it')).toBe(false);
  });
  it('reads export formats', () => {
    expect(parseFormat('export october for Gusto')).toBe('gusto');
    expect(parseFormat('send it as json')).toBe('generic_json');
    expect(parseFormat('export the run')).toBeNull();
  });
});

describe('phrasings the parsers must not guess (they would become instant writes)', () => {
  it.each([
    'log 20 minutes for today',
    'log 8h 30m today',
    'I worked 9 to 5 today',
    'worked 9-5 today',
    'worked 9am-5pm on friday',
    'log 8 hours yesterday and 6 today',
  ])('reads no amount from "%s"', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
  it.each([
    'log PTO next friday, full day',
    'log 8 hours yesterday and 6 today',
    'full day on monday and tuesday',
  ])('reads no day from "%s"', (text) => {
    expect(parseDay(text, TODAY)).toBeNull();
  });
  it('reads "the day before yesterday" as two days back', () => {
    expect(parseDay('8h the day before yesterday', TODAY)).toBe('2026-10-05');
  });
  it('does not add when the user says not to', () => {
    expect(isAdditive('log 8 hours for today, not more')).toBe(false);
    expect(isAdditive('no extra hours, just 8 for today')).toBe(false);
    expect(isAdditive('add 2 more hours')).toBe(true);
  });
});
