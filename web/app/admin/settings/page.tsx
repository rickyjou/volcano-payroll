'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '../../../components/AppShell';
import { ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, write } from '../../../lib/api';
import { loadSettings, type SettingsRow } from '../../../lib/data';
import { getVolcano } from '../../../lib/volcano';
import { useDataChanged } from '../../../lib/events';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
type Form = Record<'company_name' | 'ot_weekly_threshold' | 'ot_daily_threshold' | 'dt_daily_threshold' | 'ot_multiplier' | 'dt_multiplier' | 'week_starts_on', string> & { ot_applies_to_daily: boolean };

const toForm = (s: SettingsRow): Form => ({
  company_name: s.company_name,
  ot_weekly_threshold: s.ot_weekly_threshold?.toString() ?? '',
  ot_daily_threshold: s.ot_daily_threshold?.toString() ?? '',
  dt_daily_threshold: s.dt_daily_threshold?.toString() ?? '',
  ot_multiplier: String(s.ot_multiplier),
  dt_multiplier: String(s.dt_multiplier),
  week_starts_on: String(s.week_starts_on),
  ot_applies_to_daily: s.ot_applies_to_daily,
});

/** Blank → null; otherwise a positive number or an error message. */
function optionalNumber(v: string, label: string, max?: number): number | null | string {
  if (v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be a positive number`;
  if (max != null && n > max) return `${label} must be at most ${max}`;
  return n;
}

function Settings() {
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setForm(toForm(await loadSettings())); } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useDataChanged(load);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setNotice(null);
    const weekly = optionalNumber(form.ot_weekly_threshold, 'Weekly overtime threshold', 168);
    const daily = optionalNumber(form.ot_daily_threshold, 'Daily overtime threshold', 24);
    const dbl = optionalNumber(form.dt_daily_threshold, 'Daily double-time threshold', 24);
    const otm = optionalNumber(form.ot_multiplier, 'Overtime multiplier');
    const dtm = optionalNumber(form.dt_multiplier, 'Double-time multiplier');
    const problem = [weekly, daily, dbl, otm, dtm].find((x) => typeof x === 'string') as string | undefined;
    if (problem) { setError(problem); return; }
    if (typeof dbl === 'number' && typeof daily === 'number' && dbl <= daily) { setError('Double time must start after daily overtime'); return; }
    if ((otm as number | null) == null || (otm as number) < 1 || (dtm as number | null) == null || (dtm as number) < 1) { setError('Multipliers must be 1 or more'); return; }
    setBusy(true);
    setError(null);
    try {
      await write(getVolcano().update('settings', {
        company_name: form.company_name.trim() || 'My Company',
        ot_weekly_threshold: weekly as number | null, ot_daily_threshold: daily as number | null, dt_daily_threshold: dbl as number | null,
        ot_multiplier: otm as number, dt_multiplier: dtm as number,
        ot_applies_to_daily: form.ot_applies_to_daily, week_starts_on: Number(form.week_starts_on),
      }).eq('id', true), 'settings');
      setNotice('Settings saved. Draft payroll runs must be regenerated to use them.');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!form) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <form className="form-grid" onSubmit={save}>
      <Field label="Company name"><input value={form.company_name} onChange={set('company_name')} /></Field>
      <Field label="Workweek starts on">
        <select value={form.week_starts_on} onChange={set('week_starts_on')}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
      </Field>
      <Field label="Weekly overtime after (hours)" hint="Federal rule: 40. Blank = no weekly overtime."><input inputMode="decimal" value={form.ot_weekly_threshold} onChange={set('ot_weekly_threshold')} /></Field>
      <Field label="Daily overtime after (hours)" hint="California: 8. Blank = none."><input inputMode="decimal" value={form.ot_daily_threshold} onChange={set('ot_daily_threshold')} /></Field>
      <Field label="Daily double time after (hours)" hint="California: 12. Blank = none."><input inputMode="decimal" value={form.dt_daily_threshold} onChange={set('dt_daily_threshold')} /></Field>
      <Field label="Overtime multiplier"><input inputMode="decimal" value={form.ot_multiplier} onChange={set('ot_multiplier')} /></Field>
      <Field label="Double-time multiplier"><input inputMode="decimal" value={form.dt_multiplier} onChange={set('dt_multiplier')} /></Field>
      <label className="inline">
        <input type="checkbox" checked={form.ot_applies_to_daily} onChange={(e) => setForm({ ...form, ot_applies_to_daily: e.target.checked })} />
        Pay weekly overtime to daily-rate employees (they then also enter hours)
      </label>
      <p className="muted">These rules are a convenience, not legal advice. Confirm overtime rules for each work state with your payroll provider.</p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      <div className="form-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></div>
    </form>
  );
}

export default function SettingsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Settings</h1>
      <Settings />
    </AppShell>
  );
}
