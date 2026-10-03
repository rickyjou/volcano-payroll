'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { addDays, monthBounds } from '../../../../src/lib/dates';
import { AppShell } from '../../../components/AppShell';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, q, write } from '../../../lib/api';
import { listPeriods, type Period } from '../../../lib/data';
import { monthLabel } from '../../../lib/format';
import { getVolcano } from '../../../lib/volcano';
import { useDataChanged } from '../../../lib/events';

type Counts = Record<string, Record<string, number>>;

function Periods() {
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [counts, setCounts] = useState<Counts>({});
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await listPeriods();
      const sheets = p.length
        ? await q<{ pay_period_id: string; status: string }>(getVolcano().from('timesheets').select('pay_period_id,status').in('pay_period_id', p.map((x) => x.id)).limit(20000))
        : [];
      const c: Counts = {};
      for (const s of sheets) (c[s.pay_period_id] ??= {})[s.status] = ((c[s.pay_period_id] ??= {})[s.status] ?? 0) + 1;
      setPeriods(p);
      setCounts(c);
      setMonth((m) => m || (p[0] ? addDays(p[0].end_date, 1).slice(0, 7) : new Date().toISOString().slice(0, 7)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useDataChanged(load);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); setNotice(done); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  function openMonth(e: FormEvent) {
    e.preventDefault();
    const { start, end } = monthBounds(month);
    void run(() => q(getVolcano().insert('pay_periods', { start_date: start, end_date: end })), `${monthLabel(start)} is open for time entry.`);
  }

  const setStatus = (p: Period, status: Period['status'], done: string) =>
    run(() => write(getVolcano().update('pay_periods', { status }).eq('id', p.id), 'the pay period'), done);

  if (!periods) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  return (
    <>
      <form className="toolbar" onSubmit={openMonth}>
        <Field label="Month"><input type="month" required value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <button type="submit" disabled={busy}>Open month</button>
      </form>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      {periods.length === 0 ? <Empty>No pay periods yet. Open the current month to let employees record time.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Month</th><th scope="col">Status</th><th scope="col">Timesheets</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {periods.map((p) => {
                const c = counts[p.id] ?? {};
                return (
                  <tr key={p.id}>
                    <td>{monthLabel(p.start_date)}</td>
                    <td><Badge value={p.status} /></td>
                    <td>{c.approved ?? 0} approved · {c.submitted ?? 0} submitted · {(c.draft ?? 0) + (c.rejected ?? 0)} in progress</td>
                    <td className="row-actions">
                      {p.status === 'open' && <button type="button" className="small" disabled={busy} onClick={() => void setStatus(p, 'locked', 'Locked. Employees can no longer change time; generate a payroll run next.')}>Lock</button>}
                      {p.status === 'locked' && <button type="button" className="small secondary" disabled={busy} onClick={() => void setStatus(p, 'open', 'Reopened for time entry.')}>Reopen</button>}
                      {p.status === 'locked' && <Link className="button small" href="/admin/runs">Payroll run</Link>}
                      {p.status === 'open' && Object.keys(c).length === 0 && (
                        <button type="button" className="small danger" disabled={busy} onClick={() => void run(() => write(getVolcano().delete('pay_periods').eq('id', p.id), 'the pay period'), 'Deleted.')}>Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function PeriodsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Pay periods</h1>
      <p className="muted">Open a month for time entry, lock it when timesheets are approved, then run payroll.</p>
      <Periods />
    </AppShell>
  );
}
