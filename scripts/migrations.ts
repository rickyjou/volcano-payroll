// Volcano runs each migration file as exactly one SQL statement. We author
// related statements together in db/migrations-src/*.sql, each preceded by a
// `-- @file NNN_name` marker, and generate one file per statement.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = /^-- @file (\d{3}_[a-z0-9_]+)\s*$/;

export interface SqlFile { name: string; sql: string }

/** Removes comments, string literals and dollar-quoted bodies so `;` can be counted. */
export function stripSql(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; continue; }
    if (rest.startsWith('/*')) { const end = sql.indexOf('*/', i + 2); if (end === -1) throw new Error('Unterminated /* comment'); i = end + 2; continue; }
    if (sql[i] === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j++; continue; } break; } }
      if (j >= sql.length) throw new Error('Unterminated string literal');
      out += "''"; i = j + 1; continue;
    }
    const dollar = /^\$([A-Za-z_]*)\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error(`Unterminated ${tag} body`);
      out += '$$'; i = end + tag.length; continue;
    }
    out += sql[i]; i++;
  }
  return out;
}

export function isSingleStatement(sql: string): boolean {
  const s = stripSql(sql).trim();
  if (s === '') return false;
  const body = s.endsWith(';') ? s.slice(0, -1) : s;
  return !body.includes(';');
}

export function splitSource(text: string, source = 'source'): SqlFile[] {
  const files: SqlFile[] = [];
  let current: SqlFile | null = null;
  const preamble: string[] = [];
  for (const line of text.split('\n')) {
    const m = MARKER.exec(line);
    if (m) { current = { name: m[1], sql: '' }; files.push(current); continue; }
    if (current) current.sql += `${line}\n`;
    else preamble.push(line);
  }
  if (stripSql(preamble.join('\n')).trim() !== '') throw new Error(`${source}: SQL before the first -- @file marker`);
  for (const f of files) {
    f.sql = `${f.sql.trim()}\n`;
    if (!isSingleStatement(f.sql)) throw new Error(`${source}: ${f.name} must contain exactly one statement`);
  }
  return files;
}

/** Regenerates outDir/NNN_*.sql from srcDir; refuses duplicate names and removes stale generated files. */
export function generate(srcDir: string, outDir: string): SqlFile[] {
  const all: SqlFile[] = [];
  for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.sql')).sort()) {
    all.push(...splitSource(readFileSync(join(srcDir, f), 'utf8'), f));
  }
  const names = new Set<string>();
  const numbers = new Set<string>();
  for (const f of all) {
    if (names.has(f.name)) throw new Error(`Duplicate migration name ${f.name}`);
    const num = f.name.slice(0, 3);
    if (numbers.has(num)) throw new Error(`Duplicate migration number ${num} (${f.name})`);
    names.add(f.name);
    numbers.add(num);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const existing of readdirSync(outDir).filter((n) => /^\d{3}_.*\.sql$/.test(n))) {
    if (!names.has(existing.replace(/\.sql$/, ''))) unlinkSync(join(outDir, existing));
  }
  for (const f of all) writeFileSync(join(outDir, `${f.name}.sql`), f.sql);
  return all;
}
