// Admin-only bulk create/update of employees (and optional compensation) from
// rows already parsed and validated in the browser by parseEmployeeCsv.
import { validateRecords, type ImportRecord, type ImportRow } from '../lib/employee-import';
import { requireEmployee } from '../server/auth';
import { rows } from '../server/db';
import { HttpError, authOf, handle } from '../server/http';
import { userClient } from '../server/volcano';

const MAX_ROWS = 200;

interface Existing { id: string; email: string }
interface Outcome { line: number; email: string; result: 'created' | 'updated' | 'error'; message?: string }

/** Re-validates on the server: the browser could send anything. */
function revalidate(input: unknown): ImportRow[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'records must be a non-empty array');
  if (input.length > MAX_ROWS) throw new HttpError(400, 'TOO_MANY_ROWS', `Send at most ${MAX_ROWS} rows per request`);
  const records: ImportRecord[] = input.map((r: { line?: unknown; values?: unknown }) => ({
    line: Number(r?.line) || 0,
    values: r && typeof r.values === 'object' && r.values ? Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, String(v ?? '')])) : {},
  }));
  const { rows: parsed, errors } = validateRecords(records);
  if (errors.length) throw new HttpError(400, 'INVALID_ROWS', 'Some rows are invalid', errors);
  return parsed;
}

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  await requireEmployee(db, auth, ['admin']);
  const input = revalidate(event.records);
  const dryRun = event.dry_run === true;

  const emails = [...new Set([...input.map((r) => r.email), ...input.flatMap((r) => (r.manager_email ? [r.manager_email] : []))])];
  const existing = new Map((await rows<Existing>(db.from('employees').select('id,email').in('email', emails))).map((e) => [e.email, e.id]));

  const outcomes: Outcome[] = [];
  const idByEmail = new Map(existing);
  for (const r of input) {
    const fields = {
      email: r.email, first_name: r.first_name, last_name: r.last_name, external_id: r.external_id,
      role: r.role, hire_date: r.hire_date, work_state: r.work_state,
    };
    const id = existing.get(r.email);
    if (dryRun) {
      outcomes.push({ line: r.line, email: r.email, result: id ? 'updated' : 'created' });
      continue;
    }
    const res = id ? await db.update('employees', fields).eq('id', id) : await db.insert('employees', fields);
    if (res.error) {
      outcomes.push({ line: r.line, email: r.email, result: 'error', message: res.error.message });
      continue;
    }
    const saved = (res.data as { id: string }[])[0];
    idByEmail.set(r.email, saved.id);
    outcomes.push({ line: r.line, email: r.email, result: id ? 'updated' : 'created' });

    if (r.pay_type && r.rate_cents && r.effective_from) {
      const comp = { employee_id: saved.id, pay_type: r.pay_type, rate_cents: r.rate_cents, effective_from: r.effective_from };
      const [current] = await rows<{ id: string }>(db.from('compensation').select('id').eq('employee_id', saved.id).eq('effective_from', r.effective_from));
      const c = current ? await db.update('compensation', comp).eq('id', current.id) : await db.insert('compensation', comp);
      if (c.error) outcomes[outcomes.length - 1] = { line: r.line, email: r.email, result: 'error', message: `saved, but compensation failed: ${c.error.message}` };
    }
  }

  // Managers are resolved after everyone in the batch exists.
  for (const r of input) {
    if (!r.manager_email) continue;
    const managerId = idByEmail.get(r.manager_email);
    const out = outcomes.find((o) => o.line === r.line)!;
    if (!managerId) {
      out.message = `${out.message ? `${out.message}; ` : ''}manager ${r.manager_email} not found`;
      continue;
    }
    if (dryRun || out.result === 'error') continue;
    const m = await db.update('employees', { manager_id: managerId }).eq('id', idByEmail.get(r.email)!);
    if (m.error) out.message = `manager not set: ${m.error.message}`;
  }

  return {
    dry_run: dryRun,
    created: outcomes.filter((o) => o.result === 'created').length,
    updated: outcomes.filter((o) => o.result === 'updated').length,
    errors: outcomes.filter((o) => o.result === 'error' || o.message).length,
    outcomes,
  };
});
