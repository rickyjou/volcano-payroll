'use client';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { ErrorBanner, Loading } from '../../../components/ui';
import { errorMessage, q } from '../../../lib/api';
import { EMPLOYEE_COLUMNS, compensationFor, type Comp, type EmployeeRow } from '../../../lib/data';
import { RATE_UNIT, money } from '../../../lib/format';
import { useSession } from '../../../lib/session';
import { getVolcano } from '../../../lib/volcano';

function Profile() {
  const { employee } = useSession();
  const [me, setMe] = useState<EmployeeRow | null>(null);
  const [comps, setComps] = useState<Comp[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [row] = await q<EmployeeRow>(getVolcano().from('employees').select(EMPLOYEE_COLUMNS).eq('id', employee!.id));
      setMe(row);
      setComps(await compensationFor(employee!.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [employee]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!me) return <Loading />;
  return (
    <>
      <dl className="details">
        <dt>Name</dt><dd>{me.first_name} {me.last_name}</dd>
        <dt>Email</dt><dd>{me.email}</dd>
        <dt>Employee ID</dt><dd>{me.external_id ?? '—'}</dd>
        <dt>Role</dt><dd>{me.role}</dd>
        <dt>Hire date</dt><dd>{String(me.hire_date).slice(0, 10)}</dd>
        <dt>Work state</dt><dd>{me.work_state ?? '—'}</dd>
      </dl>
      <h2>Pay</h2>
      {comps.length === 0 ? <p className="muted">Not set up yet.</p> : (
        <ul className="plain">
          {comps.map((c) => <li key={c.id}>{c.pay_type}: {money(c.rate_cents)} {RATE_UNIT[c.pay_type]} from {c.effective_from}</li>)}
        </ul>
      )}
      <p className="muted">To change these details, contact your payroll administrator.</p>
    </>
  );
}

export default function ProfilePage() {
  return (
    <AppShell roles={['employee', 'manager', 'admin']}>
      <h1>Profile</h1>
      <Profile />
    </AppShell>
  );
}
