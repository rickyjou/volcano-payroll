// Each agent tool against the local stack, called directly as a real user. Needs the
// deployed Functions for the payroll, export, import, key and webhook tools.
import { beforeAll, describe, expect, it } from 'vitest';
import { invoker } from '../../src/agent/invoke';
import { toolByName } from '../../src/agent/tools';
import { Refusal, type Card, type ToolCtx } from '../../src/agent/types';
import { ok, openPeriod, resetData, seedOrg, service, type Org, type TestUser } from './helpers';

let org: Org;
let october: string;

type Who = TestUser & { employeeId: string };
const ctxOf = (who: Who, role: 'employee' | 'manager' | 'admin'): ToolCtx => ({
  db: who.client, today: '2026-10-07', invoke: invoker(who.client),
  me: { id: who.employeeId, role, first_name: who.email.split('-')[0], last_name: 'Test', email: who.email },
});
const tool = (name: string) => {
  const t = toolByName(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const refusalOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof Refusal) return err;
    throw err;
  }
  throw new Error('expected a refusal');
};
const cardOf = <K extends Card['kind']>(cards: Card[] | undefined, kind: K) => cards?.find((c) => c.kind === kind) as Extract<Card, { kind: K }>;

beforeAll(async () => {
  await resetData();
  org = await seedOrg();
  october = await openPeriod('2026-10');
});

describe('employee time tools', () => {
  const alice = () => ctxOf(org.alice, 'employee');
  const day = { day: '2026-10-07', code: 'REG' };

  it('logs an empty day without asking, and undoes it', async () => {
    expect(await tool('log_time').confirm!(alice(), { ...day, hours: 8, mode: 'set' })).toBeNull();
    const r = await tool('log_time').run(alice(), { ...day, hours: 8, mode: 'set' });
    expect(r.text).toBe('Logged 8h REG for Wed Oct 7. October 2026 total: 8h.');
    expect(r.undo).toMatchObject({ day: '2026-10-07', code: 'REG', previous: null });
  });

  it('asks before replacing hours and offers to add instead', async () => {
    const c = await tool('log_time').confirm!(alice(), { ...day, hours: 6, mode: 'set' });
    expect(c).toMatchObject({ title: 'Wed Oct 7 already has 8h REG', lines: ['You asked to log 6h.'] });
    expect(c!.choices!.map((x) => [x.id, x.label])).toEqual([['replace', 'Replace with 6h'], ['add', 'Add → 14h'], ['cancel', 'Cancel']]);
    const added = await tool('log_time').run(alice(), { ...day, hours: 6, mode: 'set' }, 'add');
    expect(added.text).toBe('Logged 8h → 14h REG for Wed Oct 7. October 2026 total: 14h.');
    expect((await tool('log_time').undo!(alice(), added.undo)).text).toBe('Undone: Wed Oct 7 is back to 8h REG.');
  });

  it("won't undo a day that has changed since", async () => {
    const r = await tool('log_time').run(alice(), { day: '2026-10-08', code: 'REG', hours: 8, mode: 'set' });
    await ok(service().update('time_entries', { hours: 6 }).eq('work_date', '2026-10-08'));
    expect((await refusalOf(tool('log_time').undo!(alice(), r.undo))).message).toBe('Thu Oct 8 has changed since (now 6h REG), so it was not undone.');
    const [e] = await ok<{ hours: string }>(service().from('time_entries').select('hours').eq('work_date', '2026-10-08'));
    expect(Number(e.hours)).toBe(6);
    await ok(service().delete('time_entries').eq('work_date', '2026-10-08'));
  });

  it('refuses impossible or misplaced time', async () => {
    expect((await refusalOf(tool('log_time').confirm!(alice(), { ...day, hours: 17, mode: 'add' }))).message).toBe('Wed Oct 7 would have 25h; the most is 24h in a day.');
    expect((await refusalOf(tool('log_time').confirm!(alice(), { ...day, days: 1, mode: 'set' }))).message).toBe('How many hours? For example "8 hours".');
    expect((await refusalOf(tool('log_time').confirm!(alice(), { day: '2026-11-02', hours: 8, mode: 'set' }))).message)
      .toBe('No pay period covers Mon Nov 2 yet. Ask your payroll admin to open November 2026.');
  });

  it('asks a daily-rate employee for days instead of hours', async () => {
    await ok(service().insert('compensation', { employee_id: org.bob.employeeId, pay_type: 'daily', rate_cents: 25_000, effective_from: '2026-10-01' }));
    const bob = ctxOf(org.bob, 'employee');
    expect((await refusalOf(tool('log_time').confirm!(bob, { ...day, hours: 8, mode: 'set' }))).message).toBe('You are paid by the day: say "full day" or "half day".');
    expect((await tool('log_time').run(bob, { ...day, days: 1, mode: 'set' })).text).toBe('Logged 1 day REG for Wed Oct 7. October 2026 total: 1 day.');
    await ok(service().delete('compensation').eq('employee_id', org.bob.employeeId).eq('effective_from', '2026-10-01'));
  });

  it('clears a day after showing what goes, and can put it back', async () => {
    await tool('log_time').run(alice(), { day: '2026-10-06', code: 'PTO', hours: 4, mode: 'set' });
    expect(await tool('clear_time').confirm!(alice(), { day: '2026-10-06' })).toMatchObject({ title: 'Remove the time on Tue Oct 6?', lines: ['4h PTO'] });
    const r = await tool('clear_time').run(alice(), { day: '2026-10-06' });
    expect(r.text).toBe('Removed 4h PTO from Tue Oct 6.');
    expect((await tool('clear_time').undo!(alice(), r.undo)).text).toBe('Undone: restored 4h PTO.');
    await tool('clear_time').run(alice(), { day: '2026-10-06' });
  });

  it('shows, submits, refuses edits while submitted, and recalls', async () => {
    expect((await tool('show_timesheet').run(alice(), {})).text).toBe('October 2026: draft. Total 8h REG.');
    const c = await tool('submit_timesheet').confirm!(alice(), {});
    expect(c!.lines[0]).toBe('Total: 8h REG');
    expect(c!.lines[1]).toMatch(/^Weekdays with nothing logged: Thu Oct 1, Fri Oct 2, Mon Oct 5, Tue Oct 6, Thu Oct 8,/);
    expect((await tool('submit_timesheet').run(alice(), {})).text).toBe('Submitted your October 2026 timesheet for approval.');
    const locked = await refusalOf(tool('log_time').confirm!(alice(), { ...day, hours: 1, mode: 'add' }));
    expect(locked.message).toBe('Your October 2026 timesheet is submitted. Recall it to make changes.');
    expect(cardOf(locked.cards, 'choices').options[0].request).toEqual({ tool: 'recall_timesheet', args: { period: october } });
    expect((await tool('recall_timesheet').run(alice(), {})).text).toBe('Recalled your October 2026 timesheet. You can edit it now.');
  });

  it('refuses a submit or recall card clicked after the timesheet already moved', async () => {
    expect((await refusalOf(tool('recall_timesheet').run(alice(), {}))).message).toBe("Your October 2026 timesheet isn't waiting for approval, so there's nothing to recall.");
    await tool('submit_timesheet').run(alice(), {});
    expect((await refusalOf(tool('submit_timesheet').run(alice(), {}))).message).toBe('Your October 2026 timesheet is already submitted.');
    await tool('recall_timesheet').run(alice(), {});
  });

  it('shows pay and profile', async () => {
    expect((await tool('show_my_pay').run(alice(), {})).text).toBe('There is no finalized pay for you yet.');
    expect((await tool('show_profile').run(alice(), {})).text).toBe(`alice Test (${org.alice.email}), employee. Pay: hourly, $25.00 / hour.`);
  });
});

describe('approval tools', () => {
  const manager = () => ctxOf(org.manager, 'manager');

  it('lists what is waiting with Approve and Return buttons', async () => {
    await tool('submit_timesheet').run(ctxOf(org.alice, 'employee'), {});
    const r = await tool('list_pending_approvals').run(manager(), {});
    const table = cardOf(r.cards, 'table');
    expect(table.rows).toEqual([['alice Test', 'October 2026', 'submitted', '8h']]);
    expect(table.rowActions![0].map((a) => [a.label, a.request.tool, a.needsNote ?? false])).toEqual([['Approve', 'approve_timesheets', false], ['Return', 'return_timesheet', true]]);
  });

  it("can't touch a timesheet that isn't a direct report's", async () => {
    const existing = await ok<{ id: string }>(service().from('timesheets').select('id').eq('employee_id', org.bob.employeeId));
    const [{ id }] = existing.length ? existing : await ok<{ id: string }>(service().insert('timesheets', { employee_id: org.bob.employeeId, pay_period_id: october }));
    await expect(tool('approve_timesheets').confirm!(manager(), { timesheets: [id] })).rejects.toThrow('Timesheet not found');
  });

  it('returns with a note, shows team status, and approves', async () => {
    const [{ id }] = await ok<{ id: string }>(service().from('timesheets').select('id').eq('employee_id', org.alice.employeeId));
    expect((await tool('show_employee_timesheet').run(manager(), { timesheet: id })).text).toBe('alice Test, October 2026: submitted, total 8h.');
    expect((await tool('return_timesheet').run(manager(), { timesheet: id, note: 'Missing Monday' })).text).toBe("Returned alice Test's October 2026 timesheet with your note.");
    expect((await tool('team_status').run(manager(), {})).text).toBe('October 2026: 0 approved, 0 submitted, 1 in progress, 0 not started.');
    await tool('submit_timesheet').run(ctxOf(org.alice, 'employee'), {});
    expect((await tool('approve_timesheets').run(manager(), { timesheets: [id] })).text).toBe('Approved alice Test (October 2026).');
    // Approved meanwhile (another tab, or the Approvals screen): refuse instead of claiming success.
    expect((await refusalOf(tool('approve_timesheets').confirm!(manager(), { timesheets: [id] }))).message)
      .toBe("Nothing to approve: alice Test's October 2026 timesheet is approved, not waiting for approval.");
    // A card shown before that and clicked now must not report success either.
    expect((await refusalOf(tool('approve_timesheets').run(manager(), { timesheets: [id] }))).message)
      .toBe("Nothing was approved. alice Test's October 2026 timesheet is approved, not waiting for approval.");
    expect((await refusalOf(tool('return_timesheet').run(manager(), { timesheet: id, note: 'Too late' }))).message)
      .toBe("alice Test's October 2026 timesheet is approved, not waiting for approval.");
  });
});

describe('admin payroll tools', () => {
  const admin = () => ctxOf(org.admin, 'admin');
  let runId: string;

  it('opens and locks months', async () => {
    expect(await tool('open_period').confirm!(admin(), { month: '2026-11' })).toMatchObject({ title: 'Open November 2026 for time entry?' });
    expect((await tool('open_period').run(admin(), { month: '2026-11' })).text).toBe('November 2026 is open for time entry.');
    expect((await tool('lock_period').run(admin(), { period: october })).text).toBe('October 2026 is locked.');
  });

  it('generates only for locked months, then explains, finalizes, exports and voids', async () => {
    const [{ id: november }] = await ok<{ id: string }>(service().from('pay_periods').select('id').eq('start_date', '2026-11-01'));
    expect((await refusalOf(tool('generate_run').confirm!(admin(), { period: november }))).message).toBe('November 2026 is open. Lock it before generating a run.');
    await ok(service().delete('timesheets').eq('employee_id', org.bob.employeeId));
    const leaveOut = [org.admin.employeeId, org.manager.employeeId, org.bob.employeeId];
    const gen = await tool('generate_run').run(admin(), { period: october, leave_out: leaveOut });
    expect(gen.text).toBe('Draft run for October 2026: $200.00 gross for 1 employee. Ready to finalize.');
    runId = (gen.data as { run: string }).run;
    expect((await tool('explain_run').run(admin(), { run: runId })).text).toBe('October 2026 run (draft): $200.00 gross for 1 employee, 0 warning(s).');
    expect((await tool('finalize_run').run(admin(), { run: runId })).text).toBe('The October 2026 run is finalized. You can export it now.');
    const exp = await tool('export_run').run(admin(), { run: runId, format: 'gusto' });
    const file = cardOf(exp.cards, 'download');
    expect(file.filename).toBe('payroll-2026-10-gusto.csv');
    expect(file.body.split('\r\n')[1]).toBe(`Test,alice,${org.alice.email},8.00,,,,,`);
    expect((await tool('void_run').run(admin(), { run: runId, reason: 'Wrong rate' })).text).toBe('The October 2026 run is voided and the month is locked again.');
    const again = await tool('generate_run').run(admin(), { period: october, leave_out: leaveOut });
    expect((await tool('discard_draft').run(admin(), { run: (again.data as { run: string }).run })).text).toBe('Discarded the October 2026 draft.');
  });

  it("counts only finalized runs in an admin's own pay (admins can read draft and voided lines)", async () => {
    const db = service();
    const august = await openPeriod('2026-08');
    await ok(db.update('pay_periods', { status: 'locked' }).eq('id', august));
    const runFor = async (cents: number) => {
      const [{ id }] = await ok<{ id: string }>(db.insert('payroll_runs', {
        pay_period_id: august,
        totals: JSON.stringify({ employee_count: 1, gross_cents: cents, by_code: { REG: { hours: 40, days: 0, amount_cents: cents } } }),
        lines_input: JSON.stringify([{
          employee_id: org.admin.employeeId, external_id: null, first_name: 'admin', last_name: 'Test', email: org.admin.email,
          pay_type: 'hourly', work_state: 'CA', earning_code: 'REG', hours: 40, days: null, rate_cents: cents / 40, amount_cents: cents,
        }]),
      }));
      return id;
    };
    const voided = await runFor(100_000);
    await ok(db.update('payroll_runs', { status: 'finalized' }).eq('id', voided));
    await ok(db.update('payroll_runs', { status: 'voided', void_reason: 'Wrong rate' }).eq('id', voided));
    const draft = await runFor(120_000);
    expect((await tool('show_my_pay').run(admin(), {})).text).toBe('There is no finalized pay for you yet.');
    await ok(db.update('payroll_runs', { status: 'finalized' }).eq('id', draft));
    expect((await tool('show_my_pay').run(admin(), {})).text).toBe('Gross pay for August 2026: $1,200.00 (before taxes and deductions).');
  });
});

describe('admin people and settings tools', () => {
  const admin = () => ctxOf(org.admin, 'admin');

  it('adds, finds, updates, pays and terminates an employee', async () => {
    const added = await tool('add_employee').run(admin(), { email: 'sam@example.com', first_name: 'Sam', last_name: 'Lee', hire_date: '2026-10-12', pay_type: 'hourly', rate: 28 });
    expect(added.text).toBe('Added Sam Lee. They can now create an account with sam@example.com.');
    const found = await tool('find_employee').run(admin(), { query: 'sam' });
    expect(found.text).toBe('1 match.');
    const sam = (found.data as { employee: string }[])[0].employee;
    expect(await tool('update_employee').confirm!(admin(), { employee: sam, role: 'manager' })).toMatchObject({ lines: ['role: employee → manager'] });
    expect((await tool('update_employee').run(admin(), { employee: sam, role: 'manager' })).text).toBe('Updated Sam Lee.');
    expect((await tool('set_pay').run(admin(), { employee: sam, pay_type: 'hourly', rate: 30, effective_from: '2026-11-01' })).text).toBe("Sam Lee's pay is hourly, $30.00 per hour from Sun Nov 1.");
    expect((await tool('terminate_employee').run(admin(), { employee: sam, date: '2026-10-31' })).text).toBe('Sam Lee is recorded as having left on Sat Oct 31.');
    expect((await refusalOf(tool('terminate_employee').confirm!(admin(), { employee: sam, date: '2026-10-31' }))).message).toBe('Sam Lee has already left (2026-10-31).');
  });

  it('changes and shows settings', async () => {
    expect((await tool('update_settings').run(admin(), { ot_daily_threshold: 8 })).text).toBe('Settings updated: ot_daily_threshold = 8.');
    expect((await tool('show_settings').run(admin(), {})).text).toMatch(/^My Company: weekly OT after 40h, daily OT after 8h, double time off\./);
  });

  it('creates and revokes API keys and webhooks, showing secrets once', async () => {
    const key = await tool('create_api_key').run(admin(), { name: 'connector' });
    expect(cardOf(key.cards, 'secret').value).toMatch(/^pk_[0-9a-f]{8}_/);
    const [{ id }] = await ok<{ id: string }>(service().from('api_keys').select('id').eq('name', 'connector'));
    expect((await tool('revoke_api_key').run(admin(), { key: id })).text).toBe('API key revoked.');
    expect((await refusalOf(tool('revoke_api_key').confirm!(admin(), { key: id }))).message).toBe('"connector" is already revoked.');
    const hook = await tool('add_webhook').run(admin(), { url: 'https://example.com/hook' });
    expect(cardOf(hook.cards, 'secret').value).toMatch(/^whsec_/);
    expect((await refusalOf(tool('add_webhook').confirm!(admin(), { url: 'http://example.com' }))).message).toBe('Webhook URLs must start with https://.');
  });

  it('links to screens chat does not cover', async () => {
    const r = await tool('open_page').run(admin(), { page: 'import_employees' });
    expect(cardOf(r.cards, 'link')).toEqual({ kind: 'link', label: 'Import employees from CSV', href: '/admin/employees/import' });
  });
});
