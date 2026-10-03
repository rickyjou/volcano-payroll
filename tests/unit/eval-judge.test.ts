import { describe, expect, it } from 'vitest';
import { judge, type Case } from '../../scripts/eval-judge';
import type { Route } from '../../src/agent/router';
import { toolByName } from '../../src/agent/tools';

const tool = (name: string, args: Record<string, unknown> = {}): Route => ({ kind: 'tool', tool: toolByName(name)!, args, confidence: 0.99 });
const read: Case = { role: 'employee', text: 'how many hours did I log today?', intent: 'show_timesheet' };
const write: Case = { role: 'employee', text: 'log 8 hours today', intent: 'log_time' };

describe('judge', () => {
  it('counts the right tool as correct and sending to the LLM as neither', () => {
    expect(judge(read, tool('show_timesheet'))).toEqual({ verdict: 'correct', writeError: false });
    expect(judge(write, { kind: 'llm', reason: 'unsure', confidence: 0.5 })).toEqual({ verdict: 'llm', writeError: false });
  });
  it('counts a wrong read as a plain error', () => {
    expect(judge(read, tool('show_my_pay'))).toEqual({ verdict: 'wrong', writeError: false });
  });
  it('counts a write labelled message sent elsewhere as a write error', () => {
    expect(judge(write, tool('show_timesheet'))).toEqual({ verdict: 'wrong', writeError: true });
  });
  it('counts a question misrouted INTO a write tool as a write error', () => {
    expect(judge(read, tool('log_time', { day: '2026-10-07', hours: 8 }))).toEqual({ verdict: 'wrong', writeError: true });
  });
  it('counts a misread "yes" or a question card leading to a write as a write error', () => {
    const cancel: Case = { role: 'employee', text: 'no, stop', intent: 'cancel' };
    expect(judge(cancel, { kind: 'confirm', confidence: 0.99 })).toEqual({ verdict: 'wrong', writeError: true });
    const ask: Route = { kind: 'ask', text: 'Which day?', confidence: 0.99, card: { kind: 'choices', prompt: 'Which day?', options: [{ label: 'Today', request: { tool: 'clear_time', args: {} } }] } };
    expect(judge(read, ask)).toEqual({ verdict: 'wrong', writeError: true });
  });
});
