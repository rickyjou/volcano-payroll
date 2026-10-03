import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, isSingleStatement, splitSource } from '../../scripts/migrations';

describe('isSingleStatement', () => {
  it('ignores semicolons inside function bodies, strings and comments', () => {
    expect(isSingleStatement(`CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;`)).toBe(true);
    expect(isSingleStatement(`INSERT INTO t VALUES ('a;b'); -- trailing; comment`)).toBe(true);
    expect(isSingleStatement(`SELECT 1; SELECT 2;`)).toBe(false);
    expect(isSingleStatement(`-- only a comment`)).toBe(false);
  });
});

describe('splitSource', () => {
  it('splits on markers and trims', () => {
    expect(splitSource('-- group header comment\n-- @file 001_a\nCREATE TABLE a (id int);\n\n-- @file 002_b\nCREATE TABLE b (id int);\n')).toEqual([
      { name: '001_a', sql: 'CREATE TABLE a (id int);\n' },
      { name: '002_b', sql: 'CREATE TABLE b (id int);\n' },
    ]);
  });
  it('rejects two statements under one marker and SQL before any marker', () => {
    expect(() => splitSource('-- @file 001_a\nSELECT 1;\nSELECT 2;\n', 'x.sql')).toThrow('x.sql: 001_a must contain exactly one statement');
    expect(() => splitSource('SELECT 1;\n-- @file 001_a\nSELECT 2;\n', 'x.sql')).toThrow('SQL before the first');
  });
});

describe('generate', () => {
  it('writes files, removes stale ones and refuses duplicate numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    const src = join(dir, 'src');
    const out = join(dir, 'out');
    mkdirSync(src);
    mkdirSync(out);
    writeFileSync(join(out, '999_stale.sql'), 'SELECT 1;\n');
    writeFileSync(join(out, 'README.md'), 'keep');
    writeFileSync(join(src, '01.sql'), '-- @file 001_a\nSELECT 1;\n');
    generate(src, out);
    expect(readdirSync(out).sort()).toEqual(['001_a.sql', 'README.md']);
    expect(readFileSync(join(out, '001_a.sql'), 'utf8')).toBe('SELECT 1;\n');
    writeFileSync(join(src, '02.sql'), '-- @file 001_b\nSELECT 2;\n');
    expect(() => generate(src, out)).toThrow('Duplicate migration number 001');
  });
});
