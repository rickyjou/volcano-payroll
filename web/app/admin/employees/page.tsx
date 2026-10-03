'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { EmployeeForm, type EmployeeValues } from '../../../components/EmployeeForm';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, q } from '../../../lib/api';
import { listEmployees, type EmployeeRow } from '../../../lib/data';
import { getVolcano } from '../../../lib/volcano';
import { useDataChanged } from '../../../lib/events';

const PAGE = 50;

function Employees() {
  const [all, setAll] = useState<EmployeeRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'active' | 'terminated' | 'all'>('active');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setAll(await listEmployees()); } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useDataChanged(load);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (all ?? []).filter((e) => (status === 'all' || e.status === status)
      && (!s || `${e.first_name} ${e.last_name} ${e.email} ${e.external_id ?? ''}`.toLowerCase().includes(s)));
  }, [all, search, status]);

  async function add(values: EmployeeValues) {
    setBusy(true);
    setError(null);
    try {
      await q(getVolcano().insert('employees', { ...values }));
      setNotice(`${values.first_name} added. Ask them to create an account with ${values.email}.`);
      setAdding(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!all) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const managers = all.filter((e) => e.status === 'active' && e.role !== 'employee');
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const managerName = (id: string | null) => { const m = all.find((e) => e.id === id); return m ? `${m.first_name} ${m.last_name}` : '—'; };

  return (
    <>
      <div className="toolbar">
        <Field label="Search"><input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Name, email or ID" /></Field>
        <Field label="Status">
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(0); }}>
            <option value="active">Active</option><option value="terminated">Terminated</option><option value="all">All</option>
          </select>
        </Field>
        <button type="button" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Cancel' : 'Add employee'}</button>
        <Link href="/admin/employees/import" className="button secondary">Import CSV</Link>
      </div>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      {adding && <section className="panel"><h2>New employee</h2><EmployeeForm managers={managers} submitLabel="Add employee" busy={busy} onSubmit={(v) => void add(v)} /></section>}
      {filtered.length === 0 ? <Empty>No employees match.</Empty> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">ID</th><th scope="col">Role</th><th scope="col">Manager</th><th scope="col">Account</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/admin/employees/${e.id}`}>{e.last_name}, {e.first_name}</Link></td>
                    <td>{e.email}</td>
                    <td>{e.external_id ?? '—'}</td>
                    <td>{e.role}</td>
                    <td>{managerName(e.manager_id)}</td>
                    <td>{e.user_id ? 'linked' : <span className="muted">invited</span>}</td>
                    <td><Badge value={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Pages">
            <button type="button" className="secondary small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page + 1} of {pages} · {filtered.length} employees</span>
            <button type="button" className="secondary small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </nav>
        </>
      )}
    </>
  );
}

export default function EmployeesPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Employees</h1>
      <Employees />
    </AppShell>
  );
}
