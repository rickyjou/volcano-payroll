import { describe, expect, it } from 'vitest';
import { guardFormula, parseCsv, toCsv } from '../../src/lib/csv';

describe('toCsv', () => {
  it('quotes only when needed and uses CRLF', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', 'line\nbreak', ' pad', 'ok']])).toBe(
      'a,"b,c","say ""hi""","line\nbreak"," pad",ok\r\n',
    );
  });
});

describe('guardFormula', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(guardFormula('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(guardFormula('+1')).toBe("'+1");
    expect(guardFormula('-2')).toBe("'-2");
    expect(guardFormula('@cmd')).toBe("'@cmd");
    expect(guardFormula('Ada')).toBe('Ada');
  });
});

describe('parseCsv', () => {
  it('round-trips quoted fields, CRLF, LF and a BOM', () => {
    expect(parseCsv('﻿a,"b,c"\r\n"x ""y""",z\nlast,"multi\nline"')).toEqual([
      ['a', 'b,c'], ['x "y"', 'z'], ['last', 'multi\nline'],
    ]);
  });
  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,,\n')).toEqual([['a', '', '']]);
  });
  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('"abc')).toThrow('Unterminated');
  });
});
