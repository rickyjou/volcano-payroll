import { describe, expect, it } from 'vitest';
import type { DeciderAnswer } from '../../src/agent/decider';
import { deciderQuestions, fillArgs, route, type Answers } from '../../src/agent/router';
import { toolByName, toolsFor } from '../../src/agent/tools';
import { DEE, fixtureContext as context, HAL, RUN, SEP } from '../agent/fixture';

const choice = (value: string, confidence = 0.97): DeciderAnswer => ({ type: 'choice', choice: value, confidence });
const noul = (p: number): DeciderAnswer => ({ type: 'noul', noul: p });
const T = 0.9;

function go(role: 'employee' | 'manager' | 'admin', text: string, answers: Answers | null, hasPending = false) {
  return route({ text, context: context(role), tools: toolsFor(role), answers, threshold: T, hasPending });
}

describe('deciderQuestions', () => {
  it('offers only the tools for the role, plus help and other', () => {
    const q = deciderQuestions(context('employee'), toolsFor('employee'), false);
    expect(q.intent.type).toBe('choice');
    const options = Object.keys((q.intent as { criteria: object }).criteria);
    expect(options).toContain('log_time');
    expect(options).not.toContain('approve_timesheets');
    expect(options).not.toContain('confirm');
    expect(options.slice(-2)).toEqual(['help', 'other']);
    expect(q.target_timesheet).toBeUndefined();
  });
  it('adds confirm/cancel when an action is waiting, and target choices for approvers and admins', () => {
    const q = deciderQuestions(context('admin'), toolsFor('admin'), true);
    expect(Object.keys((q.intent as { criteria: object }).criteria)).toEqual(expect.arrayContaining(['confirm', 'cancel', 'finalize_run']));
    expect(Object.keys((q.target_timesheet as { criteria: object }).criteria)).toEqual([HAL.id, DEE.id, 'all', 'none']);
    expect(q.target_employee).toBeDefined();
    expect(q.target_period).toBeDefined();
  });
});

describe('route', () => {
  it('runs a fully specified request without the LLM', () => {
    const r = go('employee', 'log 8 hours for today', { intent: choice('log_time'), adds_to_existing: noul(0.1), is_question: noul(0.05) });
    expect(r).toMatchObject({ kind: 'tool', args: { day: '2026-10-07', code: 'REG', hours: 8, mode: 'set' }, confidence: 0.97 });
    expect((r as { tool: { name: string } }).tool.name).toBe('log_time');
  });
  it('reads "more" as adding to the day', () => {
    const r = go('employee', 'add 2 more hours today', { intent: choice('log_time') });
    expect(r).toMatchObject({ kind: 'tool', args: { hours: 2, mode: 'add' } });
  });
  it('goes to the LLM when the decider is unsure, at the threshold boundary', () => {
    expect(go('employee', 'log 8 today', { intent: choice('log_time', 0.89) })).toMatchObject({ kind: 'llm', reason: 'unsure of intent', confidence: 0.89 });
    expect(go('employee', 'log 8 today', { intent: choice('log_time', 0.9) })).toMatchObject({ kind: 'tool' });
  });
  it('goes to the LLM without a decider, for "other", and for questions about writes', () => {
    expect(go('employee', 'hi', null)).toMatchObject({ kind: 'llm', reason: 'no decider' });
    expect(go('employee', 'why is my pay low', { intent: choice('other') })).toMatchObject({ kind: 'llm', reason: 'other' });
    expect(go('employee', 'how do I log 8 hours today?', { intent: choice('log_time'), is_question: noul(0.8) })).toMatchObject({ kind: 'llm', reason: 'question' });
  });
  it('never routes to a tool the role does not have', () => {
    expect(go('employee', 'approve hal', { intent: choice('approve_timesheets') })).toMatchObject({ kind: 'llm', reason: 'unknown intent' });
  });
  it('asks which day when only the day is missing', () => {
    const r = go('employee', 'log 8 hours', { intent: choice('log_time') });
    expect(r.kind).toBe('ask');
    const card = (r as { card: { kind: string; options: { label: string; request: { tool: string; args: object } }[] } }).card;
    expect(card.options.map((o) => o.label)).toEqual(['Today (Wed Oct 7)', 'Yesterday (Tue Oct 6)']);
    expect(card.options[1].request).toEqual({ tool: 'log_time', args: { code: 'REG', hours: 8, mode: 'set', day: '2026-10-06' } });
  });
  it('goes to the LLM when no amount was given', () => {
    expect(go('employee', 'log time today', { intent: choice('log_time') })).toMatchObject({ kind: 'llm', reason: 'no amount' });
  });
  it('picks a timesheet, all of them, or asks which', () => {
    expect(go('manager', "approve Hal's timesheet", { intent: choice('approve_timesheets'), target_timesheet: choice(HAL.id) }))
      .toMatchObject({ kind: 'tool', args: { timesheets: [HAL.id] } });
    expect(go('manager', 'approve all of them', { intent: choice('approve_timesheets'), target_timesheet: choice('all') }))
      .toMatchObject({ kind: 'tool', args: { timesheets: [HAL.id, DEE.id] } });
    const ask = go('manager', 'approve a timesheet', { intent: choice('approve_timesheets'), target_timesheet: choice(HAL.id, 0.6) });
    expect(ask.kind).toBe('ask');
  });
  it('sends returning without a note to the LLM (it must write the note)', () => {
    expect(go('manager', "return hal's", { intent: choice('return_timesheet'), target_timesheet: choice(HAL.id) })).toMatchObject({ kind: 'llm', reason: 'missing note' });
  });
  it('confirms or cancels only when something is waiting', () => {
    expect(go('employee', 'yes', { intent: choice('confirm') }, true)).toMatchObject({ kind: 'confirm' });
    expect(go('employee', 'no', { intent: choice('cancel') }, true)).toMatchObject({ kind: 'cancel' });
    expect(go('employee', 'yes', { intent: choice('confirm') }, false)).toMatchObject({ kind: 'llm', reason: 'nothing to confirm' });
  });
  it("finds the run for the month named, and the admin's months", () => {
    expect(go('admin', 'finalize the september run', { intent: choice('finalize_run') })).toMatchObject({ kind: 'tool', args: { run: RUN.id } });
    expect(go('admin', 'lock september', { intent: choice('lock_period') })).toMatchObject({ kind: 'tool', args: { period: SEP.id } });
    expect(go('admin', 'open next month', { intent: choice('open_period') })).toMatchObject({ kind: 'tool', args: { month: '2026-11' } });
    expect(go('admin', 'export september for gusto', { intent: choice('export_run') })).toMatchObject({ kind: 'tool', args: { run: RUN.id, format: 'gusto' } });
  });
});

describe('fillArgs', () => {
  it('leaves arguments it cannot fill unset', () => {
    expect(fillArgs(toolByName('log_time')!, 'log time', context('employee'), {}, T)).toEqual({ code: 'REG', mode: 'set' });
  });
});
