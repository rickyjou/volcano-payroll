'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { TimesheetGrid } from '../../components/TimesheetGrid';
import { Badge, Empty, ErrorBanner, Field, Loading } from '../../components/ui';
import { errorMessage, write } from '../../lib/api';
import {
  listEmployees, listPeriods, loadSettings, timesheetsForPeriod, type EmployeeRow, type Period, type Timesheet,
} from '../../lib/data';
import { monthLabel } from '../../lib/format';
import { useSession } from '../../lib/session';
import { getVolcano } from '../../lib/volcano';

const ORDER = { submitted: 0, rejected: 1, draft: 2, approved: 3 } as const;

function Approvals() {
  const { employee: me } = useSession();
  const isAdmin = me!.role === 'admin';
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [periodId, setPeriodId] = useState('');
  const [team, setTeam] = useState<EmployeeRow[]>([]);
  const [sheets, setSheets] = useState<Timesheet[]>([]);
  const [dailyHours, setDailyHours] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    setError(null);
    try {
      const [p, employees, s] = await Promise.all([listPeriods(), listEmployees(), loadSettings()]);
      // RLS returns direct reports to managers and everyone to admins.
      const people = employees.filter((e) => e.status === 'active' && (isAdmin || e.manager_id === me!.id));
      setPeriods(p);
      setTeam(people);
      setDailyHours(s.ot_applies_to_daily);
      setPeriodId((cur) => cur || (p.find((x) => x.status !== 'finalized') ?? p[0])?.id || '');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [isAdmin, me]);

  useEffect(() => { void loadBase(); }, [loadBase]);

  const loadSheets = useCallback(async () => {
    if (!periodId) return;
    try { setSheets(await timesheetsForPeriod(periodId)); } catch (err) { setError(errorMessage(err)); }
  }, [periodId]);

  useEffect(() => { void loadSheets(); }, [loadSheets]);

  async function decide(sheet: Timesheet, status: 'approved' | 'rejected' | 'draft') {
    setBusy(sheet.id);
    setError(null);
    try {
      const values: Record<string, string> = { status };
      if (status === 'rejected') values.rejection_note = (notes[sheet.id] ?? '').trim();
      await write(getVolcano().update('timesheets', values).eq('id', sheet.id), 'the timesheet');
      await loadSheets();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!periods) return error ? <ErrorBanner error={error} onRetry={() => void loadBase()} /> : <Loading />;
  if (periods.length === 0) return <Empty>No pay periods yet.</Empty>;
  const period = periods.find((p) => p.id === periodId)!;

  const rows = team
    .map((e) => ({ e, sheet: sheets.find((s) => s.employee_id === e.id) ?? null }))
    .sort((a, b) => (a.sheet ? ORDER[a.sheet.status] : 9) - (b.sheet ? ORDER[b.sheet.status] : 9) || a.e.last_name.localeCompare(b.e.last_name));
  const waiting = rows.filter((r) => r.sheet?.status === 'submitted').length;

  return (
    <>
      <div className="toolbar">
        <Field label="Pay period">
          <select value={periodId} onChange={(e) => { setPeriodId(e.target.value); setOpen(null); }}>
            {periods.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.start_date)} ({p.status})</option>)}
          </select>
        </Field>
        <p>{waiting} waiting for approval · {rows.filter((r) => !r.sheet || r.sheet.status === 'draft').length} not submitted</p>
      </div>
      <ErrorBanner error={error} />
      {rows.length === 0 ? <Empty>No one reports to you yet.</Empty> : (
        <ul className="cards">
          {rows.map(({ e, sheet }) => (
            <li key={e.id} className="card">
              <div className="card-head">
                <strong>{e.last_name}, {e.first_name}</strong>
                {sheet ? <Badge value={sheet.status} /> : <span className="muted">not started</span>}
                {sheet && <button type="button" className="secondary small" onClick={() => setOpen(open === sheet.id ? null : sheet.id)} aria-expanded={open === sheet.id}>{open === sheet.id ? 'Hide' : 'View'}</button>}
              </div>
              {sheet?.status === 'rejected' && <p className="muted">Returned: {sheet.rejection_note}</p>}
              {sheet && open === sheet.id && (
                <TimesheetGrid
                  timesheetId={sheet.id} periodStart={period.start_date} periodEnd={period.end_date}
                  payType="auto"
                  dailyHours={dailyHours} readOnly
                />
              )}
              {sheet?.status === 'submitted' && period.status !== 'finalized' && (sheet.employee_id !== me!.id || isAdmin) && (
                <div className="actions">
                  <button type="button" disabled={busy === sheet.id} onClick={() => void decide(sheet, 'approved')}>Approve</button>
                  <input
                    aria-label={`Reason for returning ${e.first_name}'s timesheet`} placeholder="Reason for returning"
                    value={notes[sheet.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [sheet.id]: ev.target.value })}
                  />
                  <button type="button" className="secondary" disabled={busy === sheet.id || !(notes[sheet.id] ?? '').trim()} onClick={() => void decide(sheet, 'rejected')}>Return</button>
                </div>
              )}
              {isAdmin && sheet?.status === 'approved' && period.status === 'open' && (
                <div className="actions">
                  <button type="button" className="secondary small" disabled={busy === sheet.id} onClick={() => void decide(sheet, 'draft')}>Unlock for edits</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function ManagePage() {
  return (
    <AppShell roles={['manager', 'admin']}>
      <h1>Approvals</h1>
      <Approvals />
    </AppShell>
  );
}
