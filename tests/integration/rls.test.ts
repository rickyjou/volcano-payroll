import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok, openPeriod, resetData, seedOrg, service, type Org } from './helpers';

let org: Org;
let periodId: string;

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  periodId = await openPeriod();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('employees', () => {
  it('employees see only themselves', async () => {
    expect(ids(await ok(org.alice.client.from('employees').select('id')))).toEqual([org.alice.employeeId]);
  });
  it('managers see themselves and direct reports', async () => {
    expect(ids(await ok(org.manager.client.from('employees').select('id')))).toEqual([org.alice.employeeId, org.manager.employeeId].sort());
  });
  it('admins see everyone', async () => {
    expect(await ok(org.admin.client.from('employees').select('id'))).toHaveLength(4);
  });
  it('employees cannot change their own role (RLS filters the write)', async () => {
    expect(await ok(org.alice.client.update('employees', { role: 'admin' }).eq('id', org.alice.employeeId))).toEqual([]);
    const [me] = await ok<{ role: string }>(service().from('employees').select('role').eq('id', org.alice.employeeId));
    expect(me.role).toBe('employee');
  });
  it('anonymous requests see nothing', async () => {
    const { VolcanoAuth } = await import('@volcano.dev/sdk');
    const { API, ANON, DB } = await import('./helpers');
    const anon = new VolcanoAuth({ apiUrl: API, anonKey: ANON });
    anon.database(DB);
    const { data } = await anon.from('employees').select('id');
    expect(data ?? []).toEqual([]);
  });
  it('the last active admin cannot be demoted', async () => {
    expect(await errorOf(org.admin.client.update('employees', { role: 'employee' }).eq('id', org.admin.employeeId))).toContain('CONFLICT:LAST_ADMIN');
  });
});

describe('compensation', () => {
  it('is visible to its employee and admins only', async () => {
    expect(await ok(org.alice.client.from('compensation').select('id'))).toHaveLength(1);
    expect(await ok(org.manager.client.from('compensation').select('id').eq('employee_id', org.alice.employeeId))).toEqual([]);
    expect(await ok(org.bob.client.from('compensation').select('id').eq('employee_id', org.alice.employeeId))).toEqual([]);
    expect(await ok(org.admin.client.from('compensation').select('id'))).toHaveLength(4);
  });
  it('cannot be written by employees', async () => {
    expect(await errorOf(org.alice.client.insert('compensation', { employee_id: org.alice.employeeId, pay_type: 'hourly', rate_cents: 99_999, effective_from: '2026-01-01' })))
      .not.toBe('');
  });
});

describe('timesheets', () => {
  let aliceSheet: string;
  beforeAll(async () => {
    [{ id: aliceSheet }] = await ok<{ id: string }>(org.alice.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }));
    await ok(org.alice.client.insert('time_entries', { timesheet_id: aliceSheet, work_date: '2026-09-07', earning_code: 'REG', hours: 8 }));
  });

  it('cannot be created for someone else', async () => {
    expect(await errorOf(org.bob.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }))).not.toBe('');
  });
  it('are visible to the owner, their manager and admins only', async () => {
    expect(await ok(org.alice.client.from('timesheets').select('id'))).toHaveLength(1);
    expect(await ok(org.manager.client.from('timesheets').select('id').eq('id', aliceSheet))).toHaveLength(1);
    expect(await ok(org.bob.client.from('timesheets').select('id').eq('id', aliceSheet))).toEqual([]);
    expect(await ok(org.bob.client.from('time_entries').select('id'))).toEqual([]);
    expect(await ok(org.admin.client.from('time_entries').select('id'))).toHaveLength(1);
  });
  it('entries cannot be written by the manager', async () => {
    expect(await ok(org.manager.client.update('time_entries', { hours: 1 }).eq('timesheet_id', aliceSheet))).toEqual([]);
  });
});

describe('payroll tables', () => {
  it('are hidden from non-admins', async () => {
    for (const t of ['payroll_runs', 'exports', 'api_keys', 'webhook_endpoints', 'webhook_deliveries', 'audit_log']) {
      expect(await ok(org.manager.client.from(t).select('id')), t).toEqual([]);
    }
  });
});
