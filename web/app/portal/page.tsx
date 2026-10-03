'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { TimesheetGrid, type SaveState } from '../../components/TimesheetGrid';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../components/ui';
import { errorMessage, q, write } from '../../lib/api';
import { compAt, compensationFor, listPeriods, loadSettings, type Comp, type Period, type Timesheet } from '../../lib/data';
import { monthLabel } from '../../lib/format';
import { useSession } from '../../lib/session';
import { getVolcano } from '../../lib/volcano';
import { useDataChanged } from '../../lib/events';

function MyTimesheet() {
  const { employee } = useSession();
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [periodId, setPeriodId] = useState<string>('');
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Bumped when the assistant changes time, so the grid reloads its entries.
  const [gridVersion, setGridVersion] = useState(0);
  const [comps, setComps] = useState<Comp[]>([]);
  const [dailyHours, setDailyHours] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBase = useCallback(async () => {
    setError(null);
    try {
      const [p, c, s] = await Promise.all([listPeriods(), compensationFor(employee!.id), loadSettings()]);
      setPeriods(p);
      setComps(c);
      setDailyHours(s.ot_applies_to_daily);
      setPeriodId((cur) => cur || (p.find((x) => x.status === 'open') ?? p[0])?.id || '');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [employee]);

  useEffect(() => { void loadBase(); }, [loadBase]);

  const loadSheet = useCallback(async () => {
    if (!periodId || !employee) return;
    setSheet(null);
    try {
      const [s] = await q<Timesheet>(getVolcano().from('timesheets')
        .select('id,employee_id,pay_period_id,status,rejection_note,submitted_at,approved_at')
        .eq('employee_id', employee.id).eq('pay_period_id', periodId));
      setSheet(s ?? null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [periodId, employee]);

  useEffect(() => { void loadSheet(); }, [loadSheet]);
  useDataChanged(() => { void loadSheet(); setGridVersion((v) => v + 1); });

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); await loadSheet(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const start = () => act(() => q(getVolcano().insert('timesheets', { employee_id: employee!.id, pay_period_id: periodId })));
  const submit = () => act(() => write(getVolcano().update('timesheets', { status: 'submitted' }).eq('id', sheet!.id), 'the timesheet'));
  const recall = () => act(() => write(getVolcano().update('timesheets', { status: 'draft' }).eq('id', sheet!.id), 'the timesheet'));

  if (!periods) return error ? <ErrorBanner error={error} onRetry={() => void loadBase()} /> : <Loading />;
  if (periods.length === 0) return <Empty>No pay periods are open yet. Your administrator will open one.</Empty>;

  const period = periods.find((p) => p.id === periodId)!;
  const comp = compAt(comps, period.end_date);
  const editable = !!sheet && ['draft', 'rejected'].includes(sheet.status) && period.status === 'open';
  // Submitting locks the grid, so wait until every change has reached the database.
  const submittable = saveState === 'idle' || saveState === 'saved';

  return (
    <>
      <div className="toolbar">
        <Field label="Pay period">
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.start_date)} ({p.status})</option>)}
          </select>
        </Field>
        {sheet && <Badge value={sheet.status} />}
      </div>
      <ErrorBanner error={error} />
      {!comp && <Notice>Your pay details aren&apos;t set up yet. You can still record time.</Notice>}
      {sheet?.status === 'rejected' && <div className="alert error" role="alert">Returned by your manager: {sheet.rejection_note}</div>}
      {period.status !== 'open' && <Notice>This period is {period.status}; time can no longer be changed.</Notice>}

      {!sheet ? (
        period.status === 'open'
          ? <button type="button" onClick={() => void start()} disabled={busy}>Start my {monthLabel(period.start_date)} timesheet</button>
          : <Empty>You did not record time for this period.</Empty>
      ) : (
        <>
          <TimesheetGrid
            key={`${sheet.id}-${gridVersion}`} timesheetId={sheet.id} periodStart={period.start_date} periodEnd={period.end_date}
            payType={comp?.pay_type ?? 'hourly'} dailyHours={dailyHours} readOnly={!editable}
            onSaveStateChange={setSaveState}
          />
          <div className="actions">
            {editable && (
              <button type="button" onClick={() => void submit()} disabled={busy || !submittable}>
                {saveState === 'pending' || saveState === 'saving' ? 'Saving changes…' : 'Submit for approval'}
              </button>
            )}
            {editable && saveState === 'error' && <span className="muted">Fix the highlighted cells before submitting.</span>}
            {sheet.status === 'submitted' && period.status === 'open' && (
              <button type="button" className="secondary" onClick={() => void recall()} disabled={busy}>Recall to edit</button>
            )}
          </div>
        </>
      )}
    </>
  );
}

export default function PortalPage() {
  return (
    <AppShell roles={['employee', 'manager', 'admin']}>
      <h1>My timesheet</h1>
      <MyTimesheet />
    </AppShell>
  );
}
