import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok, openPeriod, resetData, seedOrg, service, type Org } from './helpers';

let org: Org;
let periodId: string;
let sheet: string;

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  periodId = await openPeriod();
  [{ id: sheet }] = await ok<{ id: string }>(org.alice.client.insert('timesheets', { employee_id: org.alice.employeeId, pay_period_id: periodId }));
});

const status = async (table: string, id: string) =>
  (await ok<{ status: string }>(service().from(table).select('status').eq('id', id)))[0].status;

describe('timesheet workflow', () => {
  it('rejects entries outside the period', async () => {
    expect(await errorOf(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-10-01', earning_code: 'REG', hours: 8 })))
      .toContain('CONFLICT:OUTSIDE_PERIOD');
  });
  it('does not let an employee approve their own timesheet', async () => {
    expect(await errorOf(org.alice.client.update('timesheets', { status: 'approved' }).eq('id', sheet))).toContain('CONFLICT:INVALID_TRANSITION');
  });
  it('locks entries once submitted', async () => {
    await ok(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-09-07', earning_code: 'REG', hours: 9 }));
    await ok(org.alice.client.update('timesheets', { status: 'submitted' }).eq('id', sheet));
    expect(await errorOf(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-09-08', earning_code: 'REG', hours: 8 })))
      .toContain('CONFLICT:TIMESHEET_LOCKED');
  });
  it('needs a note to reject, then lets the owner fix and resubmit', async () => {
    expect(await errorOf(org.manager.client.update('timesheets', { status: 'rejected' }).eq('id', sheet))).toContain('CONFLICT:NOTE_REQUIRED');
    await ok(org.manager.client.update('timesheets', { status: 'rejected', rejection_note: 'Missing Tuesday' }).eq('id', sheet));
    await ok(org.alice.client.insert('time_entries', { timesheet_id: sheet, work_date: '2026-09-08', earning_code: 'REG', hours: 8 }));
    await ok(org.alice.client.update('timesheets', { status: 'submitted' }).eq('id', sheet));
    const [row] = await ok<{ rejection_note: string | null }>(service().from('timesheets').select('rejection_note').eq('id', sheet));
    expect(row.rejection_note).toBeNull();
  });
  it('managers approve their reports and are recorded as approver', async () => {
    await ok(org.manager.client.update('timesheets', { status: 'approved' }).eq('id', sheet));
    const [row] = await ok<{ status: string; approved_by: string }>(service().from('timesheets').select('status,approved_by').eq('id', sheet));
    expect(row).toEqual({ status: 'approved', approved_by: org.manager.employeeId });
  });
  it('lets an admin approve the unsubmitted timesheet of someone who has left, but not of an active employee', async () => {
    const [{ id: bobSheet }] = await ok<{ id: string }>(org.bob.client.insert('timesheets', { employee_id: org.bob.employeeId, pay_period_id: periodId }));
    await ok(org.bob.client.insert('time_entries', { timesheet_id: bobSheet, work_date: '2026-09-01', earning_code: 'PTO', hours: 8 }));
    expect(await errorOf(org.admin.client.update('timesheets', { status: 'approved' }).eq('id', bobSheet))).toContain('CONFLICT:INVALID_TRANSITION');
    await ok(org.admin.client.update('employees', { status: 'terminated', termination_date: '2026-09-15' }).eq('id', org.bob.employeeId));
    await ok(org.admin.client.update('timesheets', { status: 'approved' }).eq('id', bobSheet));
    const [row] = await ok<{ status: string; approved_by: string }>(service().from('timesheets').select('status,approved_by').eq('id', bobSheet));
    expect(row).toEqual({ status: 'approved', approved_by: org.admin.employeeId });
  });
});

describe('payroll run lifecycle', () => {
  let runId: string;
  const lines = () => JSON.stringify([{
    employee_id: org.alice.employeeId, external_id: 'E-ALICE', first_name: 'alice', last_name: 'Test', email: org.alice.email,
    pay_type: 'hourly', work_state: null, earning_code: 'REG', hours: 17, days: null, rate_cents: 2500, amount_cents: 42_500,
  }]);

  it('needs a locked period', async () => {
    expect(await errorOf(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: '[]' }))).toContain('CONFLICT:PERIOD_NOT_LOCKED');
  });
  it('expands lines on insert and keeps JSON columns as JSON', async () => {
    await ok(org.admin.client.update('pay_periods', { status: 'locked' }).eq('id', periodId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', {
      pay_period_id: periodId,
      totals: JSON.stringify({ employee_count: 1, gross_cents: 42_500, by_code: {} }),
      warnings: JSON.stringify([{ employee_id: org.bob.employeeId, code: 'NO_APPROVED_TIMESHEET', blocking: true, message: 'x' }]),
      lines_input: lines(),
    }));
    const [run] = await ok<{ totals: { gross_cents: number }; lines_input: string | null }>(service().from('payroll_runs').select('totals,lines_input').eq('id', runId));
    expect(run.totals.gross_cents).toBe(42_500);
    expect(run.lines_input).toBeNull();
    const l = await ok<{ hours: string; amount_cents: number; pay_period_id: string }>(service().from('payroll_run_lines').select('hours,amount_cents,pay_period_id').eq('run_id', runId));
    expect(l).toEqual([{ hours: '17.00', amount_cents: 42_500, pay_period_id: periodId }]);
  });
  it('allows only one active run per period', async () => {
    expect(await errorOf(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: '[]' }))).toMatch(/duplicate key|unique/i);
  });
  it('blocks the reopening of a period with a run', async () => {
    expect(await errorOf(org.admin.client.update('pay_periods', { status: 'open' }).eq('id', periodId))).toContain('CONFLICT:RUN_EXISTS');
  });
  it('refuses to finalize with blocking warnings', async () => {
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_HAS_BLOCKING_WARNINGS');
  });
  it('refuses to finalize a stale draft', async () => {
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines() }));
    await ok(org.admin.client.insert('compensation', { employee_id: org.alice.employeeId, pay_type: 'hourly', rate_cents: 2600, effective_from: '2026-12-01' }));
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_STALE');
  });
  it('refuses to finalize after compensation is corrected in place', async () => {
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines() }));
    await ok(org.admin.client.update('compensation', { rate_cents: 2700 }).eq('employee_id', org.alice.employeeId).eq('effective_from', '2026-12-01'));
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_STALE');
  });
  it('refuses to finalize after an input row is deleted', async () => {
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines() }));
    await ok(org.admin.client.delete('compensation').eq('employee_id', org.alice.employeeId).eq('effective_from', '2026-12-01'));
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_STALE');
  });
  it('refuses to finalize when data changed while the draft was being calculated', async () => {
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    const [{ version }] = await ok<{ version: number }>(org.admin.client.from('payroll_inputs').select('version'));
    await ok(org.admin.client.insert('compensation', { employee_id: org.alice.employeeId, pay_type: 'hourly', rate_cents: 2600, effective_from: '2026-12-01' }));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines(), inputs_version: version }));
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId))).toContain('CONFLICT:RUN_STALE');
  });
  it('finalizes: freezes the run, finalizes the period, shows lines to the employee and queues webhooks', async () => {
    await ok(org.admin.client.insert('webhook_endpoints', { url: 'https://example.com/hook', secret: `whsec_${'x'.repeat(40)}` }));
    await ok(org.admin.client.delete('payroll_runs').eq('id', runId));
    [{ id: runId }] = await ok<{ id: string }>(org.admin.client.insert('payroll_runs', { pay_period_id: periodId, lines_input: lines() }));
    expect(await ok(org.alice.client.from('payroll_run_lines').select('id'))).toEqual([]);
    await ok(org.admin.client.update('payroll_runs', { status: 'finalized' }).eq('id', runId));
    expect(await status('pay_periods', periodId)).toBe('finalized');
    expect(await ok(org.alice.client.from('payroll_run_lines').select('id'))).toHaveLength(1);
    expect(await ok(org.bob.client.from('payroll_run_lines').select('id'))).toEqual([]);
    const d = await ok<{ event: string; payload: { data: { run_id: string } } }>(service().from('webhook_deliveries').select('event,payload'));
    expect(d.map((x) => [x.event, x.payload.data.run_id])).toEqual([['payroll_run.finalized', runId]]);
    expect(await errorOf(org.admin.client.update('payroll_runs', { totals: '{"edited":true}' }).eq('id', runId))).toContain('CONFLICT:RUN_FROZEN');
    expect(await errorOf(org.admin.client.delete('payroll_runs').eq('id', runId))).toContain('CONFLICT:RUN_FROZEN');
    expect(await errorOf(org.admin.client.update('timesheets', { status: 'draft' }).eq('id', sheet))).toContain('CONFLICT:PERIOD_FINALIZED');
  });
  it('voids with a reason and relocks the period', async () => {
    expect(await errorOf(org.admin.client.update('payroll_runs', { status: 'voided' }).eq('id', runId))).toContain('CONFLICT:NOTE_REQUIRED');
    await ok(org.admin.client.update('payroll_runs', { status: 'voided', void_reason: 'wrong rate' }).eq('id', runId));
    expect(await status('pay_periods', periodId)).toBe('locked');
    expect(await ok(org.alice.client.from('payroll_run_lines').select('id'))).toEqual([]);
    const events = (await ok<{ event: string }>(service().from('webhook_deliveries').select('event'))).map((x) => x.event).sort();
    expect(events).toEqual(['payroll_run.finalized', 'payroll_run.voided']);
  });
  it('audits the important changes', async () => {
    const actions = (await ok<{ action: string }>(org.admin.client.from('audit_log').select('action').limit(500))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['timesheet.approved', 'timesheet.rejected', 'payroll_run.finalized', 'payroll_run.voided']));
  });
});
