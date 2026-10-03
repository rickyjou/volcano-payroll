// Admin-only payroll run lifecycle: generate (draft), finalize, void.
// State rules are enforced by database triggers (05_payroll_logic.sql); this
// function computes pay and turns trigger errors into HTTP responses.
import { calculateRun } from '../lib/pay-calc';
import { requireEmployee } from '../server/auth';
import { asJson, mutated, one, rows } from '../server/db';
import { HttpError, authOf, handle, requireString } from '../server/http';
import { loadCalcInput, loadPeriod } from '../server/payroll-data';
import { serviceClient, userClient } from '../server/volcano';
import { dispatchDue } from '../server/webhooks';

async function sendWebhooks() {
  try {
    return await dispatchDue(serviceClient());
  } catch (e) {
    console.error('webhook dispatch failed', e);
    return null;
  }
}

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  await requireEmployee(db, auth, ['admin']);
  const action = requireString(event.action, 'action');

  if (action === 'generate') {
    const period = await loadPeriod(db, requireString(event.period_id, 'period_id'));
    if (period.status !== 'locked') throw new HttpError(409, 'PERIOD_NOT_LOCKED', 'Lock the pay period before generating a run');
    const skipped = Array.isArray(event.skipped_employee_ids) ? event.skipped_employee_ids.map(String) : [];
    // Read before the data, so a change made while we calculate makes the draft stale.
    const { version } = await one<{ version: number }>(db.from('payroll_inputs').select('version'), 'Payroll inputs version not found');
    const result = calculateRun(await loadCalcInput(db, period, skipped));

    await rows(db.delete('payroll_runs').eq('pay_period_id', period.id).eq('status', 'draft'));
    const [run] = await rows<{ id: string }>(db.insert('payroll_runs', {
      pay_period_id: period.id,
      totals: asJson(result.totals),
      warnings: asJson(result.warnings),
      skipped_employee_ids: asJson(skipped),
      lines_input: asJson(result.lines),
      inputs_version: version,
    }));
    return { run_id: run.id, totals: result.totals, warnings: result.warnings, line_count: result.lines.length };
  }

  const runId = requireString(event.run_id, 'run_id');
  if (action === 'finalize') {
    await mutated(db.update('payroll_runs', { status: 'finalized' }).eq('id', runId).eq('status', 'draft'), 'this draft run');
    return { run_id: runId, status: 'finalized', webhooks: await sendWebhooks() };
  }
  if (action === 'void') {
    const reason = requireString(event.reason, 'reason');
    await mutated(db.update('payroll_runs', { status: 'voided', void_reason: reason }).eq('id', runId).eq('status', 'finalized'), 'this finalized run');
    return { run_id: runId, status: 'voided', webhooks: await sendWebhooks() };
  }
  if (action === 'discard') {
    await one(db.from('payroll_runs').select('id').eq('id', runId).eq('status', 'draft'), 'Draft run not found');
    await rows(db.delete('payroll_runs').eq('id', runId));
    return { run_id: runId, status: 'deleted' };
  }
  throw new HttpError(400, 'BAD_REQUEST', `Unknown action "${action}"`);
});
