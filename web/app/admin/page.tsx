'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { Badge, ErrorBanner, Loading } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { listEmployees, listPeriods, listRuns, timesheetsForPeriod, type Period, type Run, type Timesheet } from '../../lib/data';
import { money, monthLabel } from '../../lib/format';

function Dashboard() {
  const [data, setData] = useState<{ period: Period | null; sheets: Timesheet[]; active: number; run: Run | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [periods, employees, runs] = await Promise.all([listPeriods(), listEmployees(), listRuns()]);
      const period = periods.find((p) => p.status !== 'finalized') ?? periods[0] ?? null;
      const sheets = period ? await timesheetsForPeriod(period.id) : [];
      setData({ period, sheets, active: employees.filter((e) => e.status === 'active').length, run: runs[0] ?? null });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;
  const count = (s: string) => data.sheets.filter((t) => t.status === s).length;
  return (
    <div className="tiles">
      <section className="tile">
        <h2>Current period</h2>
        {data.period ? (
          <>
            <p>{monthLabel(data.period.start_date)} <Badge value={data.period.status} /></p>
            <p>{count('approved')} approved · {count('submitted')} waiting · {data.active - count('approved') - count('submitted')} not submitted</p>
            <Link href="/admin/periods">Manage periods</Link>
          </>
        ) : <p><Link href="/admin/periods">Open your first pay period</Link></p>}
      </section>
      <section className="tile">
        <h2>Latest payroll run</h2>
        {data.run ? (
          <>
            <p><Badge value={data.run.status} /> {money(data.run.totals?.gross_cents ?? 0)} gross</p>
            <Link href={`/admin/runs/${data.run.id}`}>Open run</Link>
          </>
        ) : <p><Link href="/admin/runs">No runs yet</Link></p>}
      </section>
      <section className="tile">
        <h2>People</h2>
        <p>{data.active} active employees</p>
        <Link href="/admin/employees">Manage employees</Link>
      </section>
    </div>
  );
}

export default function AdminHome() {
  return (
    <AppShell roles={['admin']}>
      <h1>Payroll admin</h1>
      <Dashboard />
    </AppShell>
  );
}
