import { describe, expect, it } from 'vitest';
import { withoutLlm } from '../../src/agent/agent';
import { decideByRules, RuleDecider } from '../../src/agent/rule-decider';
import { deciderQuestions, deciderState, route, type Route } from '../../src/agent/router';
import { toolsFor } from '../../src/agent/tools';
import type { Role } from '../../src/agent/types';
import { DEE, fixtureContext, HAL, PEOPLE } from '../agent/fixture';

// Phrasings the labelled evaluation set does not contain, run through the real router.
function go(role: Role, text: string, hasPending = false): Route {
  const context = fixtureContext(role);
  const tools = toolsFor(role);
  return route({ text, context, tools, answers: decideByRules(text, deciderQuestions(context, tools, hasPending)), threshold: 0.9, hasPending });
}
const toolOf = (r: Route) => (r.kind === 'tool' ? r.tool.name : r.kind === 'ask' && r.card.kind === 'choices' ? `ask:${r.card.options[0].request.tool}` : r.kind);

describe('RuleDecider', () => {
  it('reads the message out of the decider state', async () => {
    const context = fixtureContext('employee');
    const answers = await new RuleDecider().decide(deciderState('User: Ada.\nToday: Wed.', 'show my timesheet'), deciderQuestions(context, toolsFor('employee'), false));
    expect(answers.intent).toMatchObject({ choice: 'show_timesheet', confidence: 0.95 });
  });

  it.each([
    ['employee', 'please log 7 hours for yesterday', 'log_time', { day: '2026-10-06', hours: 7 }],
    ['employee', 'I took a half day of PTO today', 'log_time', { day: '2026-10-07', code: 'PTO', days: 0.5 }],
    ['employee', 'add 30 more hours today', 'log_time', { mode: 'add', hours: 30 }],
    ['employee', 'what have I logged so far', 'show_timesheet', {}],
    ['employee', 'send in my timesheet for approval, submit it', 'submit_timesheet', {}],
    ['employee', 'wipe yesterday', 'clear_time', { day: '2026-10-06' }],
    ['manager', 'approve dee', 'approve_timesheets', { timesheets: [DEE.id] }],
    ['manager', 'please approve every timesheet', 'approve_timesheets', { timesheets: [HAL.id, DEE.id] }],
    ['manager', "send hal's back: friday is missing", 'return_timesheet', { timesheet: HAL.id, note: 'Friday is missing' }],
    ['admin', 'look up hal@example.com', 'find_employee', { employee: PEOPLE[0].id }],
    ['admin', 'regenerate the september run', 'generate_run', {}],
    ['admin', 'make a new api key called Gusto sync', 'create_api_key', { name: 'Gusto sync' }],
  ] as const)('[%s] "%s" runs %s', (role, text, tool, args) => {
    const r = go(role, text);
    expect(toolOf(r)).toBe(tool);
    expect(r).toMatchObject({ args });
  });

  it.each([
    ['employee', 'log time on friday', 'ask:log_time'],
    ['manager', 'approve it', 'ask:approve_timesheets'],
    ['manager', 'yes, approve it', 'confirm'],
  ] as const)('[%s] "%s" → %s', (role, text, expected) => {
    expect(toolOf(go(role, text, expected === 'confirm'))).toBe(expected);
  });

  // None of these may land on a write: each goes to the LLM (or the no-LLM reply) or a read.
  it.each([
    ['employee', 'how do I submit my timesheet?'],
    ['employee', "don't submit my timesheet"],
    ['employee', 'approve my timesheet'],
    ['employee', "I didn't work today"],
    ['employee', 'yes'],
    ['employee', 'thanks, log it'],
    ['manager', 'can you approve hal?'],
    ['manager', 'approve hal and dee'],
    ['manager', 'why did dee return nothing'],
    ['admin', 'remove hal'],
    ['admin', 'how many hours has hal left'],
    ['admin', 'set daily overtime to 8 hours'],
    ['admin', 'make mia an admin'],
    ['admin', 'lock november'],
    ['admin', 'finalize the november run'],
  ] as const)('[%s] "%s" does not write', (role, text) => {
    const r = go(role, text);
    const writes = (r.kind === 'tool' && r.tool.kind === 'write') || r.kind === 'confirm' || r.kind === 'cancel';
    expect(writes ? toolOf(r) : 'no write').toBe('no write');
  });

  it('confirms with "yes" only when something is waiting, and only a bare or short yes', () => {
    expect(go('employee', 'yes', true).kind).toBe('confirm');
    expect(go('employee', 'yes please', true).kind).toBe('confirm');
    expect(toolOf(go('employee', 'yes, log 8 hours today', true))).toBe('log_time');
    expect(go('employee', 'no thanks', true).kind).toBe('cancel');
  });

  it('answers low when nothing fits, so the turn goes to the LLM', () => {
    const a = decideByRules('tell me about the weather', deciderQuestions(fixtureContext('admin'), toolsFor('admin'), false));
    expect(a.intent).toMatchObject({ choice: 'other', confidence: 0.3 });
    expect(a.target_employee).toMatchObject({ choice: 'none', confidence: 0.3 });
  });
});

describe('withoutLlm', () => {
  const llmRoute = (r: Route) => r as Extract<Route, { kind: 'llm' }>;
  it('says what is missing when the request was understood', () => {
    expect(withoutLlm('manager', llmRoute(go('manager', "return hal's"))))
      .toBe('To send a submitted timesheet back to the employee with a note saying what to fix, I also need: what the employee should fix. Please say it again with that included.');
    expect(withoutLlm('employee', llmRoute(go('employee', 'I worked some hours')))).toMatch(/I also need: the day worked; how many hours \(or days\)\./);
  });
  it('names a month without a pay period, and lists examples otherwise', () => {
    expect(withoutLlm('admin', llmRoute(go('admin', 'lock november')))).toBe('There\'s no pay period for that month. Say "list pay periods" to see them.');
    expect(withoutLlm('employee', llmRoute(go('employee', 'tell me a joke')))).toMatch(/^I can only handle simple requests right now, such as:\n• Log 8 hours for today/);
  });
});
