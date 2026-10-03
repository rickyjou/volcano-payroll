'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { Badge, Empty, ErrorBanner, Loading } from '../../../components/ui';
import { errorMessage, q } from '../../../lib/api';
import { listPeriods, type Period, type Timesheet } from '../../../lib/data';
import { money, monthLabel, qty } from '../../../lib/format';
import { useSession } from '../../../lib/session';
import { getVolcano } from '../../../lib/volcano';

interface Line { pay_period_id: string; earning_code: string; hours: string | null; days: string | null; amount_cents: number }

function History() {
  const { employee } = useSession();
  const [data, setData] = useState<{ periods: Period[]; sheets: Timesheet[]; lines: Line[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const db = getVolcano();
      const [periods, sheets, lines] = await Promise.all([
        listPeriods(),
        q<Timesheet>(db.from('timesheets').select('id,employee_id,pay_period_id,status,rejection_note,submitted_at,approved_at').eq('employee_id', employee!.id)),
        // RLS returns only this employee's lines, and only from finalized runs.
        q<Line>(db.from('payroll_run_lines').select('pay_period_id,earning_code,hours,days,amount_cents').eq('employee_id', employee!.id).limit(2000)),
      ]);
      setData({ periods, sheets, lines });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [employee]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;
  if (data.sheets.length === 0) return <Empty>No timesheets yet.</Empty>;

  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th scope="col">Month</th><th scope="col">Timesheet</th><th scope="col">Gross pay</th></tr></thead>
        <tbody>
          {data.periods.filter((p) => data.sheets.some((s) => s.pay_period_id === p.id)).map((p) => {
            const sheet = data.sheets.find((s) => s.pay_period_id === p.id)!;
            const lines = data.lines.filter((l) => l.pay_period_id === p.id);
            return (
              <tr key={p.id}>
                <td>{monthLabel(p.start_date)}</td>
                <td><Badge value={sheet.status} /></td>
                <td>
                  {lines.length > 0 ? (
                    <details>
                      <summary>{money(lines.reduce((s, l) => s + Number(l.amount_cents), 0))}</summary>
                      <ul className="plain">
                        {lines.map((l, i) => (
                          <li key={i}>{l.earning_code}: {l.hours != null ? `${qty(l.hours)} h` : `${qty(l.days)} d`} — {money(l.amount_cents)}</li>
                        ))}
                      </ul>
                    </details>
                  ) : <span className="muted">Not finalized</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">Gross pay before taxes and deductions, which your payroll provider calculates.</p>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <AppShell roles={['employee', 'manager', 'admin']}>
      <h1>History</h1>
      <History />
    </AppShell>
  );
}
