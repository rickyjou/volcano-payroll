'use client';
import Link from 'next/link';
import { useState } from 'react';
import { IMPORT_COLUMNS, parseEmployeeCsv, type ImportError, type ImportRecord, type ImportRow } from '../../../../../src/lib/employee-import';
import { AppShell } from '../../../../components/AppShell';
import { ErrorBanner, Notice } from '../../../../components/ui';
import { ApiError, errorMessage, invoke } from '../../../../lib/api';
import { downloadFile } from '../../../../lib/format';

const BATCH = 100;

interface Outcome { line: number; email: string; result: 'created' | 'updated' | 'error'; message?: string }

function Importer() {
  const [parsed, setParsed] = useState<{ rows: ImportRow[]; errors: ImportError[]; records: ImportRecord[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    setParsed(null);
    setOutcomes([]);
    setError(null);
    if (!file) return;
    if (file.size > 2_000_000) { setError('That file is larger than 2 MB. Split it and import in parts.'); return; }
    setParsed(parseEmployeeCsv(await file.text()));
  }

  async function runImport() {
    if (!parsed) return;
    const valid = new Set(parsed.rows.map((r) => r.line));
    const records = parsed.records.filter((r) => valid.has(r.line));
    setOutcomes([]);
    setError(null);
    setProgress({ done: 0, total: records.length });
    const all: Outcome[] = [];
    try {
      for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        const res = await invoke<{ outcomes: Outcome[] }>('employee-import', { records: batch, dry_run: false });
        all.push(...res.outcomes);
        setOutcomes([...all]);
        setProgress({ done: Math.min(i + BATCH, records.length), total: records.length });
      }
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? ` (${(err.details as ImportError[]).map((d) => `line ${d.line}: ${d.message}`).join('; ')})` : '';
      setError(`Import stopped: ${errorMessage(err)}${details}. Rows already imported were saved; fix the file and import again — existing emails are updated, not duplicated.`);
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <p><Link href="/admin/employees">← Employees</Link></p>
      <p>
        Columns: <code>{IMPORT_COLUMNS.join(', ')}</code>. Required: email, first_name, last_name, hire_date (YYYY-MM-DD).
        Rate is dollars per year (salary), hour (hourly) or day (daily). Existing employees are matched by email and updated.{' '}
        <button type="button" className="link" onClick={() => downloadFile('employees-template.csv', 'text/csv', `${IMPORT_COLUMNS.join(',')}\r\nada@example.com,Ada,Lovelace,E-001,employee,,2024-01-15,CA,hourly,32.50,\r\n`)}>
          Download a template
        </button>
      </p>
      <label className="field">
        <span className="label">CSV file</span>
        <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      <ErrorBanner error={error} />
      {parsed && (
        <section className="panel">
          <p>{parsed.rows.length} row(s) ready · {new Set(parsed.errors.map((e) => e.line)).size} row(s) with problems</p>
          {parsed.errors.length > 0 && (
            <ul className="problems">
              {parsed.errors.map((e, i) => <li key={i}>Line {e.line}: {e.message}</li>)}
            </ul>
          )}
          <button type="button" disabled={parsed.rows.length === 0 || !!progress} onClick={() => void runImport()}>
            {progress ? `Importing ${progress.done} / ${progress.total}…` : `Import ${parsed.rows.length} row(s)`}
          </button>
          {parsed.errors.length > 0 && parsed.rows.length > 0 && <p className="muted">Rows with problems are skipped.</p>}
        </section>
      )}
      {outcomes.length > 0 && (
        <section className="panel">
          <Notice>
            {outcomes.filter((o) => o.result === 'created').length} created · {outcomes.filter((o) => o.result === 'updated').length} updated · {outcomes.filter((o) => o.result === 'error' || o.message).length} need attention
          </Notice>
          <ul className="problems">
            {outcomes.filter((o) => o.result === 'error' || o.message).map((o) => <li key={o.line}>Line {o.line} ({o.email}): {o.message}</li>)}
          </ul>
        </section>
      )}
    </>
  );
}

export default function ImportPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Import employees</h1>
      <Importer />
    </AppShell>
  );
}
