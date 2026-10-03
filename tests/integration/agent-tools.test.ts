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

  it('shows pay and profile', async () => {
    expect((await tool('show_my_pay').run(alice(), {})).text).toBe('There is no finalized pay for you yet.');
    expect((await tool('show_profile').run(alice(), {})).text).toBe(`alice Test (${org.alice.email}), employee. Pay: hourly, $25.00 / hour.`);
  });
});
