import { describe, expect, it } from 'vitest';
import { HttpDecider, picked, probability } from '../../src/agent/decider';
import { OpenAiCompatibleLlm } from '../../src/agent/llm';

function fakeFetch(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpDecider', () => {
  it('posts a state and typed questions and returns the answers', async () => {
    const f = fakeFetch({ model: 'm', answers: { intent: { type: 'choice', choice: 'log_time', confidence: 0.97, probabilities: {} } }, usage: {} });
    const d = new HttpDecider({ url: 'http://decider:8000/', token: 'secret', fetchImpl: f.impl });
    const answers = await d.decide('state', { intent: { type: 'choice', instructions: 'What?', criteria: { log_time: 'record hours', other: null } } });
    expect(answers.intent).toMatchObject({ choice: 'log_time', confidence: 0.97 });
    expect(f.calls[0].url).toBe('http://decider:8000/v1/systemone');
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      state: 'state',
      questions: { intent: { type: 'choice', instructions: 'What?', criteria: { log_time: 'record hours', other: null } } },
    });
  });
  it('fails on an HTTP error so the agent can fall back', async () => {
    const d = new HttpDecider({ url: 'http://decider', fetchImpl: fakeFetch({}, 422).impl });
    await expect(d.decide('s', { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow('HTTP 422');
  });
  it('reads answers against a threshold', () => {
    const answers = { a: { type: 'choice' as const, choice: 'x', confidence: 0.95 }, b: { type: 'choice' as const, choice: 'y', confidence: 0.5 }, c: { type: 'noul' as const, noul: 0.8 } };
    expect(picked(answers, 'a', 0.9)).toEqual({ value: 'x', confidence: 0.95 });
    expect(picked(answers, 'b', 0.9)).toBeNull();
    expect(picked(null, 'a', 0.9)).toBeNull();
    expect(probability(answers, 'c')).toBe(0.8);
    expect(probability(answers, 'a')).toBeNull();
  });
});

describe('OpenAiCompatibleLlm', () => {
  it('sends tools and history in the chat-completions shape and parses tool calls', async () => {
    const f = fakeFetch({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'log_time', arguments: '{"day":"2026-10-07"}' } }] } }] });
    const llm = new OpenAiCompatibleLlm({ url: 'http://llm/v1', model: 'small', fetchImpl: f.impl });
    const out = await llm.complete({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'show_timesheet', args: {} }] },
        { role: 'tool', toolCallId: 'c0', content: '{"ok":true}' },
        { role: 'user', content: 'log 8' },
      ],
      tools: [{ name: 'log_time', description: 'Log', parameters: { type: 'object' } }],
    });
    expect(out).toEqual({ text: '', toolCalls: [{ id: 'c1', name: 'log_time', args: { day: '2026-10-07' } }] });
    expect(f.calls[0].url).toBe('http://llm/v1/chat/completions');
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.model).toBe('small');
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'log_time', description: 'Log', parameters: { type: 'object' } } }]);
    expect(body.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'show_timesheet', arguments: '{}' } }] });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '{"ok":true}' });
  });
  it('treats unparseable tool arguments as null instead of throwing', async () => {
    const f = fakeFetch({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{bad' } }] } }] });
    const out = await new OpenAiCompatibleLlm({ url: 'http://llm', model: 'm', fetchImpl: f.impl }).complete({ messages: [], tools: [] });
    expect(out.toolCalls[0].args).toBeNull();
  });
  it("gives up when the turn's remaining time runs out, even before its own timeout", async () => {
    // A server that never answers; only the abort signal ends the request.
    const hang = ((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const llm = new OpenAiCompatibleLlm({ url: 'http://llm', model: 'm', timeoutMs: 20_000, fetchImpl: hang });
    const started = Date.now();
    await expect(llm.complete({ messages: [], tools: [], timeoutMs: 50 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
