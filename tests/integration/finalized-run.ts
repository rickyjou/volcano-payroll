import { ok, openPeriod, service, type Org } from './helpers';

/** A finalized September run with one line for Alice, created through the service key. */
export async function finalizedRun(org: Org): Promise<{ periodId: string; runId: string }> {
  const db = service();
  const periodId = await openPeriod('2026-09');
  await ok(db.update('pay_periods', { status: 'locked' }).eq('id', periodId));
  const [{ id: runId }] = await ok<{ id: string }>(db.insert('payroll_runs', {
    pay_period_id: periodId,
    totals: JSON.stringify({ employee_count: 1, gross_cents: 100_000, by_code: { REG: { hours: 40, days: 0, amount_cents: 100_000 } } }),
    lines_input: JSON.stringify([{
      employee_id: org.alice.employeeId, external_id: 'E-ALICE', first_name: 'Alice', last_name: 'Test', email: org.alice.email,
      pay_type: 'hourly', work_state: 'CA', earning_code: 'REG', hours: 40, days: null, rate_cents: 2500, amount_cents: 100_000,
    }]),
  }));
  await ok(db.update('payroll_runs', { status: 'finalized' }).eq('id', runId));
  return { periodId, runId };
}
