'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PRESETS } from '../../../../../src/lib/exporters';
import { EARNING_CODES } from '../../../../../src/lib/types';
import { AppShell } from '../../../../components/AppShell';
import { Badge, ErrorBanner, Field, Loading, Notice } from '../../../../components/ui';
import { errorMessage, invoke, q } from '../../../../lib/api';
import { listPeriods, type Period, type Run } from '../../../../lib/data';
import { dateTime, downloadFile, money, monthLabel, qty } from '../../../../lib/format';
import { getVolcano } from '../../../../lib/volcano';

interface Line { id: string; employee_id: string; first_name: string; last_name: string; external_id: string | null; pay_type: string; earning_code: string; hours: string | null; days: string | null; rate_cents: number; amount_cents: number }
interface ExportRow { id: string; mapping_key: string; filename: string; created_at: string; sha256: string; api_key_id: string | null }
interface Mapping { id: string; name: string }

function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [mappingKey, setMappingKey] = useState('generic_csv');
  const [voidReason, setVoidReason] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const db = getVolcano();
      const [r] = await q<Run>(db.from('payroll_runs')
        .select('id,pay_period_id,status,totals,warnings,skipped_employee_ids,generated_at,finalized_at,voided_at,void_reason').eq('id', id));
      if (!r) { setError('Payroll run not found'); return; }
      const [periods, l, ex, maps] = await Promise.all([
        listPeriods(),
        q<Line>(db.from('payroll_run_lines').select('id,employee_id,first_name,last_name,external_id,pay_type,earning_code,hours,days,rate_cents,amount_cents').eq('run_id', id).order('last_name').limit(10000)),
        q<ExportRow>(db.from('exports').select('id,mapping_key,filename,created_at,sha256,api_key_id').eq('run_id', id).order('created_at', { ascending: false }).limit(50)),
        q<Mapping>(db.from('export_mappings').select('id,name').order('name')),
      ]);
      setRun(r);
      setPeriod(periods.find((p) => p.id === r.pay_period_id) ?? null);
      setLines(l);
      setExports(ex);
      setMappings(maps);
      setSkip(new Set(r.skipped_employee_ids ?? []));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done: string, after?: (result: unknown) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      setNotice(done);
      after?.(result);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return lines.filter((l) => !s || `${l.first_name} ${l.last_name} ${l.external_id ?? ''}`.toLowerCase().includes(s));
  }, [lines, search]);

  if (!run) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const blocking = run.warnings.filter((w) => w.blocking);
  const regenerate = () => act(
    () => invoke<{ run_id: string }>('payroll-run', { action: 'generate', period_id: run.pay_period_id, skipped_employee_ids: [...skip] }),
    'Draft regenerated.',
    (r) => { const next = (r as { run_id: string }).run_id; if (next !== id) window.location.assign(`/admin/runs/${next}`); },
  );

  return (
    <>
      <p><Link href="/admin/runs">← Payroll runs</Link></p>
      <h1>{period ? monthLabel(period.start_date) : 'Payroll run'} <Badge value={run.status} /></h1>
      <p className="muted">
        Generated {dateTime(run.generated_at)}
        {run.finalized_at && ` · finalized ${dateTime(run.finalized_at)}`}
        {run.voided_at && ` · voided ${dateTime(run.voided_at)}: ${run.void_reason}`}
      </p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <h2>Totals</h2>
        <p><strong>{money(run.totals.gross_cents)}</strong> gross for {run.totals.employee_count} employees</p>
        <table>
          <thead><tr><th scope="col">Code</th><th scope="col">Hours</th><th scope="col">Days</th><th scope="col">Amount</th></tr></thead>
          <tbody>
            {EARNING_CODES.filter((c) => run.totals.by_code[c]).map((c) => (
              <tr key={c}><td>{c}</td><td>{run.totals.by_code[c]!.hours}</td><td>{run.totals.by_code[c]!.days}</td><td>{money(run.totals.by_code[c]!.amount_cents)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {run.warnings.length > 0 && (
        <section className="panel">
          <h2>Warnings</h2>
          <ul className="problems">
            {run.warnings.map((w, i) => (
              <li key={i}>
                {w.blocking ? <strong>Must fix: </strong> : 'Note: '}{w.message}
                {w.blocking && run.status === 'draft' && (
                  <label className="inline">
                    <input type="checkbox" checked={skip.has(w.employee_id)} onChange={(e) => {
                      const next = new Set(skip);
                      if (e.target.checked) next.add(w.employee_id); else next.delete(w.employee_id);
                      setSkip(next);
                    }} /> leave out of this run
                  </label>
                )}
              </li>
            ))}
          </ul>
          {run.status === 'draft' && <p className="muted">Fix the problem (approve the timesheet, add pay) or tick “leave out”, then regenerate.</p>}
        </section>
      )}

      {run.status === 'draft' && (
        <section className="panel actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void regenerate()}>Regenerate draft</button>
          <button type="button" disabled={busy || blocking.length > 0} onClick={() => {
            if (window.confirm('Finalize this payroll run? Lines are frozen and integrations are notified.')) {
              void act(() => invoke('payroll-run', { action: 'finalize', run_id: id }), 'Finalized. You can now export it.');
            }
          }}>Finalize</button>
          <button type="button" className="danger" disabled={busy} onClick={() => {
            if (window.confirm('Discard this draft?')) void act(() => invoke('payroll-run', { action: 'discard', run_id: id }), 'Draft discarded.', () => window.location.assign('/admin/runs'));
          }}>Discard draft</button>
          {blocking.length > 0 && <p className="muted">Finalize is disabled until every “must fix” warning is resolved.</p>}
        </section>
      )}

      {run.status === 'finalized' && (
        <section className="panel">
          <h2>Export</h2>
          <div className="toolbar">
            <Field label="Format">
              <select value={mappingKey} onChange={(e) => setMappingKey(e.target.value)}>
                <optgroup label="Built-in">{PRESETS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</optgroup>
                {mappings.length > 0 && <optgroup label="Custom">{mappings.map((m) => <option key={m.id} value={`custom:${m.id}`}>{m.name}</option>)}</optgroup>}
              </select>
            </Field>
            <button type="button" disabled={busy} onClick={() => void act(
              () => invoke<{ filename: string; content_type: string; body: string }>('payroll-export', { run_id: id, mapping_key: mappingKey }),
              'Export created.',
              (r) => { const f = r as { filename: string; content_type: string; body: string }; downloadFile(f.filename, f.content_type, f.body); },
            )}>Export and download</button>
          </div>
          <p className="muted">{PRESETS.find((p) => p.key === mappingKey)?.note}</p>
          {exports.length > 0 && (
            <table>
              <thead><tr><th scope="col">File</th><th scope="col">Created</th><th scope="col">By</th><th scope="col" /></tr></thead>
              <tbody>
                {exports.map((x) => (
                  <tr key={x.id}>
                    <td>{x.filename}</td><td>{dateTime(x.created_at)}</td><td>{x.api_key_id ? 'API' : 'admin'}</td>
                    <td><button type="button" className="link" onClick={async () => {
                      try {
                        const [f] = await q<{ filename: string; content_type: string; content: string }>(getVolcano().from('exports').select('filename,content_type,content').eq('id', x.id));
                        downloadFile(f.filename, f.content_type, f.content);
                      } catch (err) { setError(errorMessage(err)); }
                    }}>Download again</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>Void</h3>
          <p className="muted">Voiding reopens the period for a corrected run and notifies integrations.</p>
          <div className="toolbar">
            <Field label="Reason"><input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></Field>
            <button type="button" className="danger" disabled={busy || !voidReason.trim()} onClick={() => {
              if (window.confirm('Void this finalized run?')) void act(() => invoke('payroll-run', { action: 'void', run_id: id, reason: voidReason.trim() }), 'Run voided. The period is locked again; generate a new run when ready.');
            }}>Void run</button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Lines</h2>
        <Field label="Find employee"><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Employee</th><th scope="col">ID</th><th scope="col">Type</th><th scope="col">Code</th><th scope="col">Hours</th><th scope="col">Days</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <td>{l.last_name}, {l.first_name}</td><td>{l.external_id ?? '—'}</td><td>{l.pay_type}</td><td>{l.earning_code}</td>
                  <td>{qty(l.hours)}</td><td>{qty(l.days)}</td><td>{money(l.rate_cents)}</td><td>{money(l.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  return <AppShell roles={['admin']}><RunDetail id={id} /></AppShell>;
}
