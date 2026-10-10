import { VolcanoAuth } from '@volcano.dev/sdk';

export const API = process.env.VOLCANO_API_URL ?? 'http://localhost:8000';
export const ANON = process.env.VOLCANO_ANON_KEY ?? 'ak-0000000000000000000000000000000000000000';
export const SERVICE = process.env.VOLCANO_SERVICE_KEY ?? 'sk-1111111111111111111111111111111111111111';
export const DB = process.env.PAYROLL_DATABASE ?? process.env.VOLCANO_DATABASE ?? 'payroll';
export const PASSWORD = 'Integration-Test-Password-1!';

// These tests wipe the database; refuse to run anywhere but the local stack.
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) {
  throw new Error(`Integration tests only run against a local Volcano stack (VOLCANO_API_URL=${API})`);
}

export function service(): VolcanoAuth {
  const v = new VolcanoAuth({ apiUrl: API, anonKey: SERVICE, accessToken: SERVICE });
  v.database(DB);
  return v;
}

export interface TestUser { client: VolcanoAuth; userId: string; email: string }

let counter = 0;

/** Creates and signs in a fresh auth user (local stacks don't require email confirmation). */
export async function newUser(label: string): Promise<TestUser> {
  const email = `${label}-${Date.now()}-${counter++}@example.com`;
  const client = new VolcanoAuth({ apiUrl: API, anonKey: ANON });
  const up = await client.auth.signUp({ email, password: PASSWORD });
  if (up.error) throw up.error;
  const { user, error } = await client.auth.signIn({ email, password: PASSWORD });
  if (error || !user) throw error ?? new Error('sign in failed');
  client.database(DB);
  return { client, userId: user.id, email };
}

type Res = { data: unknown; error: Error | null };

export async function ok<T = Record<string, unknown>>(q: PromiseLike<Res>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function errorOf(q: PromiseLike<Res>): Promise<string> {
  const { error } = await q;
  return error?.message ?? '';
}

const NIL = '00000000-0000-0000-0000-000000000000';

/** Deletes all application data (service key bypasses RLS and guard checks). */
export async function resetData(): Promise<void> {
  const db = service();
  for (const t of ['agent_actions', 'chat_messages', 'webhook_deliveries', 'webhook_endpoints', 'exports', 'api_keys', 'export_mappings', 'payroll_runs', 'time_entries', 'timesheets', 'pay_periods', 'compensation']) {
    await ok(db.delete(t).neq('id', NIL));
  }
  await ok(db.delete('audit_log').gte('id', 0));
  // Settings is a singleton that survives deletes; put the defaults back.
  await ok(db.update('settings', {
    company_name: 'My Company', ot_weekly_threshold: 40, ot_daily_threshold: null, dt_daily_threshold: null,
    ot_multiplier: 1.5, dt_multiplier: 2, ot_applies_to_daily: false, week_starts_on: 0,
  }).eq('id', true));
  await ok(db.update('employees', { manager_id: null }).neq('id', NIL));
  await ok(db.delete('employees').neq('id', NIL));
}

export interface Org {
  admin: TestUser & { employeeId: string };
  manager: TestUser & { employeeId: string };
  alice: TestUser & { employeeId: string };
  bob: TestUser & { employeeId: string };
}

/** Admin, a manager, Alice (reports to the manager, hourly) and Bob (no manager, salaried). */
export async function seedOrg(): Promise<Org> {
  const db = service();
  const make = async (label: string, role: string, extra: Record<string, string | null> = {}) => {
    const u = await newUser(label);
    const [row] = await ok<{ id: string }>(db.insert('employees', {
      email: u.email, first_name: label, last_name: 'Test', role, hire_date: '2020-01-01', user_id: u.userId, ...extra,
    }));
    return { ...u, employeeId: row.id };
  };
  const admin = await make('admin', 'admin');
  const manager = await make('manager', 'manager');
  const alice = await make('alice', 'employee', { manager_id: manager.employeeId, external_id: 'E-ALICE' });
  const bob = await make('bob', 'employee', { external_id: 'E-BOB' });
  await ok(db.insert('compensation', { employee_id: alice.employeeId, pay_type: 'hourly', rate_cents: 2500, effective_from: '2020-01-01' }));
  await ok(db.insert('compensation', { employee_id: bob.employeeId, pay_type: 'salary', rate_cents: 12_000_000, effective_from: '2020-01-01' }));
  await ok(db.insert('compensation', { employee_id: manager.employeeId, pay_type: 'salary', rate_cents: 15_000_000, effective_from: '2020-01-01' }));
  await ok(db.insert('compensation', { employee_id: admin.employeeId, pay_type: 'salary', rate_cents: 18_000_000, effective_from: '2020-01-01' }));
  return { admin, manager, alice, bob };
}

export async function openPeriod(month = '2026-09'): Promise<string> {
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [p] = await ok<{ id: string }>(service().insert('pay_periods', { start_date: `${month}-01`, end_date: end }));
  return p.id;
}
