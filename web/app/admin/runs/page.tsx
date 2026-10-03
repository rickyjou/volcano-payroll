'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { Badge, Empty, ErrorBanner, Loading } from '../../../components/ui';
import { errorMessage, invoke } from '../../../lib/api';
import { listPeriods, listRuns, type Period, type Run } from '../../../lib/data';
import { dateTime, money, monthLabel } from '../../../lib/format';

function Runs() {
  const router = useRouter();
  const [data, setData] = useState<{ periods: Period[]; runs: Run[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [periods, runs] = await Promise.all([listPeriods(), listRuns()]);
      setData({ periods, runs });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function generate(periodId: string) {
    setBusy(periodId);
    setError(null);
    try {
      const r = await invoke<{ run_id: string }>('payroll-run', { action: 'generate', period_id: periodId });
      router.push(`/admin/runs/${r.run_id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  if (!data) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const period = (id: string) => data.periods.find((p) => p.id === id);
  const ready = data.periods.filter((p) => p.status === 'locked' && !data.runs.some((r) => r.pay_period_id === p.id && r.status !== 'voided'));

  return (
    <>
      <ErrorBanner error={error} />
      {ready.length > 0 && (
        <section className="panel">
          <h2>Ready to run</h2>
          {ready.map((p) => (
            <p key={p.id}>
              {monthLabel(p.start_date)}{' '}
              <button type="button" disabled={!!busy} onClick={() => void generate(p.id)}>{busy === p.id ? 'Calculating…' : 'Generate draft run'}</button>
            </p>
          ))}
        </section>
      )}
      {data.runs.length === 0 ? <Empty>No payroll runs yet. Lock a pay period on the Pay periods page, then generate a run here.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Month</th><th scope="col">Status</th><th scope="col">Employees</th><th scope="col">Gross</th><th scope="col">Generated</th><th scope="col">Finalized</th></tr></thead>
            <tbody>
              {data.runs.map((r) => {
                const p = period(r.pay_period_id);
                return (
                  <tr key={r.id}>
                    <td><Link href={`/admin/runs/${r.id}`}>{p ? monthLabel(p.start_date) : r.pay_period_id}</Link></td>
                    <td><Badge value={r.status} /></td>
                    <td>{r.totals?.employee_count ?? 0}</td>
                    <td>{money(r.totals?.gross_cents ?? 0)}</td>
                    <td>{dateTime(r.generated_at)}</td>
                    <td>{dateTime(r.finalized_at)}</td>
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

export default function RunsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Payroll runs</h1>
      <Runs />
    </AppShell>
  );
}
