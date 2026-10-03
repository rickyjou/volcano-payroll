'use client';
import { useState, type FormEvent } from 'react';
import { normalizeEmail, ROLES, type Role } from '../../src/lib/employee-import';
import type { EmployeeRow } from '../lib/data';
import { Field } from './ui';

export interface EmployeeValues {
  email: string; first_name: string; last_name: string; external_id: string | null; role: Role;
  manager_id: string | null; hire_date: string; work_state: string | null;
}

interface Props {
  initial?: Partial<EmployeeRow>;
  managers: EmployeeRow[];
  submitLabel: string;
  busy: boolean;
  onSubmit(values: EmployeeValues): void;
}

export function EmployeeForm({ initial = {}, managers, submitLabel, busy, onSubmit }: Props) {
  const [v, setV] = useState({
    email: initial.email ?? '', first_name: initial.first_name ?? '', last_name: initial.last_name ?? '',
    external_id: initial.external_id ?? '', role: (initial.role ?? 'employee') as Role, manager_id: initial.manager_id ?? '',
    hire_date: initial.hire_date ? String(initial.hire_date).slice(0, 10) : '', work_state: initial.work_state ?? '',
  });
  const [stateError, setStateError] = useState<string | undefined>();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    const state = v.work_state.trim().toUpperCase();
    if (state && !/^[A-Z]{2}$/.test(state)) { setStateError('Use a 2-letter state code, e.g. CA'); return; }
    setStateError(undefined);
    onSubmit({
      email: normalizeEmail(v.email), first_name: v.first_name.trim(), last_name: v.last_name.trim(),
      external_id: v.external_id.trim() || null, role: v.role, manager_id: v.manager_id || null,
      hire_date: v.hire_date, work_state: state || null,
    });
  }

  return (
    <form onSubmit={submit} className="form-grid">
      <Field label="Work email"><input type="email" required value={v.email} onChange={set('email')} /></Field>
      <Field label="First name"><input required value={v.first_name} onChange={set('first_name')} /></Field>
      <Field label="Last name"><input required value={v.last_name} onChange={set('last_name')} /></Field>
      <Field label="Employee ID" hint="The ID your payroll provider uses"><input value={v.external_id} onChange={set('external_id')} /></Field>
      <Field label="Role">
        <select value={v.role} onChange={set('role')}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      </Field>
      <Field label="Manager">
        <select value={v.manager_id} onChange={set('manager_id')}>
          <option value="">None</option>
          {managers.filter((m) => m.id !== initial.id).map((m) => <option key={m.id} value={m.id}>{m.last_name}, {m.first_name}</option>)}
        </select>
      </Field>
      <Field label="Hire date"><input type="date" required value={v.hire_date} onChange={set('hire_date')} /></Field>
      <Field label="Work state" error={stateError}><input maxLength={2} value={v.work_state} onChange={set('work_state')} /></Field>
      <div className="form-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
    </form>
  );
}
