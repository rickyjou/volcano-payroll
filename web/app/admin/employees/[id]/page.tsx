'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { dollarsToCents } from '../../../../../src/lib/money';
import type { PayType } from '../../../../../src/lib/types';
import { AppShell } from '../../../../components/AppShell';
import { EmployeeForm, type EmployeeValues } from '../../../../components/EmployeeForm';
import { Badge, ErrorBanner, Field, Loading, Notice } from '../../../../components/ui';
import { errorMessage, q, write } from '../../../../lib/api';
import { compensationFor, listEmployees, type Comp, type EmployeeRow } from '../../../../lib/data';
import { RATE_UNIT, money } from '../../../../lib/format';
import { getVolcano } from '../../../../lib/volcano';
import { useDataChanged } from '../../../../lib/events';

function EmployeeDetail({ id }: { id: string }) {
  const [all, setAll] = useState<EmployeeRow[] | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comp, setComp] = useState({ pay_type: 'hourly' as PayType, rate: '', effective_from: '' });
  const [termDate, setTermDate] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [e, c] = await Promise.all([listEmployees(), compensationFor(id)]);
      setAll(e);
      setComps(c);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useDataChanged(load);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); setNotice(done); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const save = (v: EmployeeValues) => run(() => write(getVolcano().update('employees', { ...v }).eq('id', id), 'the employee'), 'Saved.');

  function addComp(e: FormEvent) {
    e.preventDefault();
    let cents: number;
    try { cents = dollarsToCents(comp.rate); } catch { setError('Enter the rate as a dollar amount, e.g. 25.50'); return; }
    if (cents <= 0) { setError('The rate must be more than zero'); return; }
    void run(() => q(getVolcano().insert('compensation', {
      employee_id: id, pay_type: comp.pay_type, rate_cents: cents, effective_from: comp.effective_from,
    })), 'Pay change added.');
  }

  if (!all) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const emp = all.find((e) => e.id === id);
  if (!emp) return <p>Employee not found. <Link href="/admin/employees">Back to employees</Link></p>;
  const managers = all.filter((e) => e.status === 'active' && e.role !== 'employee');

  return (
    <>
      <p><Link href="/admin/employees">← Employees</Link></p>
      <h1>{emp.first_name} {emp.last_name} <Badge value={emp.status} /></h1>
      <p className="muted">{emp.user_id ? 'Account linked.' : `Invited — not signed up yet. They should create an account with ${emp.email}.`}</p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <h2>Details</h2>
        <EmployeeForm key={emp.id + emp.email} initial={emp} managers={managers} submitLabel="Save changes" busy={busy} onSubmit={(v) => void save(v)} />
      </section>

      <section className="panel">
        <h2>Pay</h2>
        {comps.length === 0 ? <p className="muted">No pay set up. Payroll will flag this employee until you add one.</p> : (
          <table>
            <thead><tr><th scope="col">Effective from</th><th scope="col">Type</th><th scope="col">Rate</th></tr></thead>
            <tbody>{comps.map((c) => <tr key={c.id}><td>{c.effective_from}</td><td>{c.pay_type}</td><td>{money(c.rate_cents)} {RATE_UNIT[c.pay_type]}</td></tr>)}</tbody>
          </table>
        )}
        <form onSubmit={addComp} className="form-grid">
          <Field label="Pay type">
            <select value={comp.pay_type} onChange={(e) => setComp({ ...comp, pay_type: e.target.value as PayType })}>
              <option value="salary">Salary (per year)</option><option value="hourly">Hourly</option><option value="daily">Daily</option>
            </select>
          </Field>
          <Field label={`Rate ${RATE_UNIT[comp.pay_type]}`}><input inputMode="decimal" required value={comp.rate} onChange={(e) => setComp({ ...comp, rate: e.target.value })} placeholder="0.00" /></Field>
          <Field label="Effective from"><input type="date" required value={comp.effective_from} onChange={(e) => setComp({ ...comp, effective_from: e.target.value })} /></Field>
          <div className="form-actions"><button type="submit" disabled={busy}>Add pay change</button></div>
        </form>
      </section>

      <section className="panel">
        <h2>Employment</h2>
        {emp.status === 'active' ? (
          <form className="form-grid" onSubmit={(e) => {
            e.preventDefault();
            void run(() => write(getVolcano().update('employees', { status: 'terminated', termination_date: termDate }).eq('id', id), 'the employee'), 'Employee terminated.');
          }}>
            <Field label="Last day worked"><input type="date" required min={String(emp.hire_date).slice(0, 10)} value={termDate} onChange={(e) => setTermDate(e.target.value)} /></Field>
            <div className="form-actions"><button type="submit" className="danger" disabled={busy}>Terminate</button></div>
          </form>
        ) : (
          <>
            <p>Terminated effective {String(emp.termination_date).slice(0, 10)}.</p>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => void run(() => write(getVolcano().update('employees', { status: 'active', termination_date: null }).eq('id', id), 'the employee'), 'Employee reactivated.')}>
              Reactivate
            </button>
          </>
        )}
      </section>
    </>
  );
}

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  return <AppShell roles={['admin']}><EmployeeDetail id={id} /></AppShell>;
}
