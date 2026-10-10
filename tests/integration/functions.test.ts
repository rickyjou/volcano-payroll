// Exercises the deployed functions end to end. Needs, on the local stack:
//   npm run build:functions && volcano variables deploy && volcano functions deploy --all
// with PAYROLL_DATABASE and PAYROLL_ALLOW_UNCONFIRMED_EMAIL=true in volcano/volcano.env.
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser, ok, openPeriod, resetData, seedOrg, service, type Org, type TestUser } from './helpers';

let org: Org;
let periodId: string;

async function call<T = Record<string, unknown>>(user: TestUser, name: string, payload: Record<string, unknown> = {}): Promise<{ status: number | null; body: T }> {
  const { data, status } = await user.client.functions.invoke(name, payload as never);
  return { status, body: (typeof data === 'string' ? JSON.parse(data) : data) as T };
}

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  periodId = await openPeriod('2026-09');
  const [{ id: sheet }] = await ok<{ id: string }>(org.alice.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }));
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
    await ok(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: d, earning_code: 'REG', hours: 9 }));
  }
  await ok(org.alice.client.update('timesheets', { status: 'submitted' }).eq('id', sheet));
  await ok(org.manager.client.update('timesheets', { status: 'approved' }).eq('id', sheet));
  await ok(org.admin.client.update('pay_periods', { status: 'locked' }).eq('id', periodId));
});

describe('employee-link', () => {
  it('links an invited account by email, idempotently', async () => {
    const u = await newUser('invitee');
    // Hired after the September period so this employee doesn't add a warning to the runs below.
    const [{ id }] = await ok<{ id: string }>(service().insert('employees', { email: u.email, first_name: 'In', last_name: 'Vitee', hire_date: '2026-10-01' }));
    const first = await call<{ employee: { id: string; user_id: string } }>(u, 'employee-link');
    expect(first.status).toBe(200);
    expect(first.body.employee).toMatchObject({ id, user_id: u.userId });
    expect((await call(u, 'employee-link')).status).toBe(200);
  });
  it('refuses accounts that were not invited', async () => {
    const u = await newUser('stranger');
    expect(await call(u, 'employee-link')).toMatchObject({ status: 403, body: { code: 'NOT_INVITED' } });
  });
});

describe('payroll-run and payroll-export', () => {
  let runId: string;

  it('is admin-only', async () => {
    expect(await call(org.manager, 'payroll-run', { action: 'generate', period_id: periodId })).toMatchObject({ status: 403 });
  });

  it('generates a draft with overtime and flags missing timesheets', async () => {
    const r = await call<{ run_id: string; totals: { gross_cents: number }; warnings: { employee_id: string; code: string }[] }>(
      org.admin, 'payroll-run', { action: 'generate', period_id: periodId });
    expect(r.status).toBe(200);
    runId = r.body.run_id;
    expect(r.body.totals.gross_cents).toBe(118_750); // 40h × $25 + 5h × $37.50
    expect(r.body.warnings.map((w) => w.code)).toEqual(['NO_APPROVED_TIMESHEET', 'NO_APPROVED_TIMESHEET', 'NO_APPROVED_TIMESHEET']);
    expect(await call(org.admin, 'payroll-run', { action: 'finalize', run_id: runId })).toMatchObject({ status: 409, body: { code: 'RUN_HAS_BLOCKING_WARNINGS' } });
  });

  it('finalizes after skipping the flagged employees', async () => {
    const skip = [org.admin.employeeId, org.manager.employeeId, org.bob.employeeId];
    const r = await call<{ run_id: string; warnings: unknown[] }>(org.admin, 'payroll-run', { action: 'generate', period_id: periodId, skipped_employee_ids: skip });
    expect(r.body.warnings).toEqual([]);
    runId = r.body.run_id;
    expect(await call(org.admin, 'payroll-run', { action: 'finalize', run_id: runId })).toMatchObject({ status: 200, body: { status: 'finalized' } });
    // A second click (or a second admin) cannot finalize again.
    expect((await call(org.admin, 'payroll-run', { action: 'finalize', run_id: runId })).status).toBe(403);
  });

  it('exports the finalized run', async () => {
    const r = await call<{ filename: string; body: string }>(org.admin, 'payroll-export', { run_id: runId, mapping_key: 'gusto' });
    expect(r.status).toBe(200);
    expect(r.body.filename).toBe('payroll-2026-09-gusto.csv');
    expect(r.body.body.split('\r\n')[1]).toBe(`Test,alice,${org.alice.email},40.00,5.00,,,,`);
  });
});

describe('api-key-create', () => {
  it('returns a key once and stores only its hash', async () => {
    const r = await call<{ key: string; prefix: string }>(org.admin, 'api-key-create', { name: 'connector' });
    expect(r.body.key).toMatch(/^pk_[0-9a-f]{8}_/);
    const [row] = await ok<{ key_hash: string }>(service().from('api_keys').select('key_hash').eq('prefix', r.body.prefix));
    expect(row.key_hash).not.toContain(r.body.key);
  });
});

describe('employee-import', () => {
  it('creates new employees, updates existing ones and links managers', async () => {
    const records = [
      { line: 2, values: { email: 'new.person@example.com', first_name: 'New', last_name: 'Person', hire_date: '2026-02-01', manager_email: org.manager.email, pay_type: 'daily', rate: '200' } },
      { line: 3, values: { email: org.bob.email.toUpperCase(), first_name: 'Robert', last_name: 'Test', hire_date: '2020-01-01' } },
    ];
    const r = await call<{ created: number; updated: number; errors: number }>(org.admin, 'employee-import', { records });
    expect(r.body).toMatchObject({ created: 1, updated: 1, errors: 0 });
    const [p] = await ok<{ id: string; manager_id: string }>(service().from('employees').select('id,manager_id').eq('email', 'new.person@example.com'));
    expect(p.manager_id).toBe(org.manager.employeeId);
    expect(await ok(service().from('compensation').select('id').eq('employee_id', p.id))).toHaveLength(1);
  });
  it('rejects invalid rows without writing anything', async () => {
    const r = await call<{ code: string }>(org.admin, 'employee-import', { records: [{ line: 2, values: { email: 'bad' } }] });
    expect(r).toMatchObject({ status: 400, body: { code: 'INVALID_ROWS' } });
  });
});
