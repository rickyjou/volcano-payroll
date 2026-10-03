'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cellKey, cellsFromEntries, gridDays, inputsFor, planSave, totalsByCode, type CellValues,
} from '../../src/lib/timesheet-grid';
import { ENTRY_CODES, type EntryCode, type PayType } from '../../src/lib/types';
import { errorMessage, q } from '../lib/api';
import { entriesFor, type Entry } from '../lib/data';
import { getVolcano } from '../lib/volcano';
import { ErrorBanner, Loading } from './ui';

const CODE_LABEL: Record<EntryCode, string> = { REG: 'Worked', PTO: 'PTO', SICK: 'Sick', HOL: 'Holiday' };
const AUTOSAVE_MS = 800;

interface Props {
  timesheetId: string;
  periodStart: string;
  periodEnd: string;
  /** 'auto' infers from saved entries — for reviewers, who can't read the employee's pay. */
  payType: PayType | 'auto';
  /** Daily employees also enter hours when day-rate overtime is on. */
  dailyHours: boolean;
  readOnly: boolean;
  /** Called after each successful save with the saved entries. */
  onSaved?: (entries: Entry[]) => void;
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export function TimesheetGrid({ timesheetId, periodStart, periodEnd, payType: payTypeProp, dailyHours, readOnly, onSaved }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cells, setCells] = useState<CellValues>({});
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const e = await entriesFor(timesheetId);
      setEntries(e);
      setCells(cellsFromEntries(e));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [timesheetId]);

  useEffect(() => { void load(); }, [load]);

  const payType: PayType = payTypeProp !== 'auto' ? payTypeProp
    : entries?.some((e) => e.days != null) ? 'daily' : 'hourly';

  const save = useCallback(async () => {
    if (!entries) return;
    const plan = planSave(entries, cells, payType, dailyHours);
    setCellErrors(plan.errors);
    if (plan.inserts.length + plan.updates.length + plan.deletes.length === 0) {
      setSaveState(Object.keys(plan.errors).length ? 'error' : 'saved');
      return;
    }
    setSaveState('saving');
    const db = getVolcano();
    try {
      for (const id of plan.deletes) await q(db.delete('time_entries').eq('id', id));
      for (const u of plan.updates) await q(db.update('time_entries', { hours: u.hours, days: u.days }).eq('id', u.id));
      for (const i of plan.inserts) {
        await q(db.insert('time_entries', { timesheet_id: timesheetId, work_date: i.work_date, earning_code: i.earning_code, hours: i.hours, days: i.days }));
      }
      const fresh = await entriesFor(timesheetId);
      setEntries(fresh);
      dirty.current = false;
      setSaveState(Object.keys(plan.errors).length ? 'error' : 'saved');
      onSaved?.(fresh);
    } catch (err) {
      setSaveState('error');
      setError(errorMessage(err));
    }
  }, [entries, cells, payType, dailyHours, timesheetId, onSaved]);

  // Debounced autosave; saves never overlap.
  useEffect(() => {
    if (readOnly || !dirty.current) return;
    setSaveState('pending');
    const t = setTimeout(() => {
      const run = async () => {
        if (saving.current) await saving.current;
        saving.current = save();
        await saving.current;
        saving.current = null;
      };
      void run();
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [cells, readOnly, save]);

  function setCell(date: string, code: EntryCode, field: 'hours' | 'days', value: string) {
    dirty.current = true;
    const key = cellKey(date, code);
    setCells((prev) => ({ ...prev, [key]: { hours: prev[key]?.hours ?? '', days: prev[key]?.days ?? '', [field]: value } }));
  }

  if (error && !entries) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!entries) return <Loading label="Loading timesheet…" />;

  const totals = totalsByCode(entries);
  const unit = payType === 'daily' ? 'days' : 'hours';

  return (
    <div>
      {!readOnly && (
        <p className="save-state" aria-live="polite">
          {saveState === 'pending' && 'Unsaved changes…'}
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && 'All changes saved'}
          {saveState === 'error' && 'Some cells could not be saved — see the highlighted fields'}
        </p>
      )}
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="grid">
          <caption className="sr-only">Time entries, one row per day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {ENTRY_CODES.map((c) => <th key={c} scope="col">{CODE_LABEL[c]} ({unit})</th>)}
            </tr>
          </thead>
          <tbody>
            {gridDays(periodStart, periodEnd).map((d) => (
              <tr key={d.date} className={d.weekend ? 'weekend' : undefined}>
                <th scope="row">{d.weekday} {d.date.slice(5)}</th>
                {ENTRY_CODES.map((code) => {
                  const key = cellKey(d.date, code);
                  const want = inputsFor(payType, code, dailyHours);
                  const v = cells[key] ?? { hours: '', days: '' };
                  const err = cellErrors[key];
                  return (
                    <td key={code} className={err ? 'cell-error' : undefined}>
                      {want.days && (
                        <select
                          aria-label={`${CODE_LABEL[code]} days on ${d.date}`} disabled={readOnly}
                          value={v.days} onChange={(e) => setCell(d.date, code, 'days', e.target.value)}
                        >
                          <option value="">—</option>
                          <option value="0.5">½</option>
                          <option value="1">1</option>
                        </select>
                      )}
                      {want.hours && (
                        <input
                          aria-label={`${CODE_LABEL[code]} hours on ${d.date}`} inputMode="decimal" disabled={readOnly}
                          value={v.hours} onChange={(e) => setCell(d.date, code, 'hours', e.target.value)}
                          aria-invalid={err ? true : undefined} title={err} placeholder={want.days ? 'hrs' : ''}
                        />
                      )}
                      {err && <span className="sr-only">{err}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {ENTRY_CODES.map((c) => (
                <td key={c}>{unit === 'days' ? totals[c].days : totals[c].hours}{unit === 'days' && totals[c].hours ? ` (${totals[c].hours} h)` : ''}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
