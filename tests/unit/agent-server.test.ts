import { describe, expect, it } from 'vitest';
import { HttpDecider } from '../../src/agent/decider';
import { OpenAiCompatibleLlm } from '../../src/agent/llm';
import { RuleDecider } from '../../src/agent/rule-decider';
import { BedrockTokenSource } from '../../src/agent/bedrock-token';
import { agentConfigFromEnv, clientToday, llmToken, handleAgentHttp, parseAgentRequest } from '../../src/agent/server';

describe('agentConfigFromEnv', () => {
  it('uses the built-in rules without DECIDER_URL, and builds the HTTP clients only when configured', () => {
    expect(agentConfigFromEnv({})).toEqual({ decider: new RuleDecider(), llm: null, threshold: 0.9 });
    const c = agentConfigFromEnv({ DECIDER_URL: 'http://d', LLM_URL: 'http://l', LLM_MODEL: 'm', AGENT_DECIDER_THRESHOLD: '0.95' });
    expect(c.decider).toBeInstanceOf(HttpDecider);
    expect(c.llm).toBeInstanceOf(OpenAiCompatibleLlm);
    expect(c.threshold).toBe(0.95);
    expect(agentConfigFromEnv({ LLM_URL: 'http://l', AGENT_DECIDER_THRESHOLD: '7' })).toMatchObject({ llm: null, threshold: 0.9 });
  });
});

describe('llmToken', () => {
  const BEDROCK = 'https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1';
  it('prefers a fixed LLM_TOKEN, and renews Bedrock keys itself when there is none', () => {
    expect(llmToken({ LLM_URL: BEDROCK, LLM_TOKEN: 'k' })).toBe('k');
    const env = { LLM_URL: BEDROCK, BEDROCK_ACCESS_KEY_ID: 'AK', BEDROCK_SECRET_ACCESS_KEY: 's' };
    expect(llmToken(env)).toBeInstanceOf(BedrockTokenSource);
    expect(llmToken(env)).toBe(llmToken(env)); // one cached source across requests
    expect(llmToken({ LLM_URL: 'http://llm/v1' })).toBeUndefined();
  });
  it("uses the machine's own AWS credentials only in development", () => {
    expect(llmToken({ LLM_URL: BEDROCK, NODE_ENV: 'development' })).toBeInstanceOf(BedrockTokenSource);
    expect(llmToken({ LLM_URL: BEDROCK, NODE_ENV: 'production' })).toBeUndefined();
    // Without a way to sign, the chat runs without the LLM rather than sending unsigned calls.
    expect(agentConfigFromEnv({ LLM_URL: BEDROCK, LLM_MODEL: 'm', NODE_ENV: 'production' }).llm).toBeNull();
  });
});

describe('parseAgentRequest', () => {
  it('accepts the four request types', () => {
    expect(parseAgentRequest({ type: 'history' })).toEqual({ type: 'history' });
    expect(parseAgentRequest({ type: 'message', text: 'hi', page: '/portal' })).toEqual({ type: 'message', text: 'hi', page: '/portal' });
    expect(parseAgentRequest({ type: 'history', today: '2026-10-07' })).toEqual({ type: 'history' });
    expect(parseAgentRequest({ type: 'action', actionId: 'a', choice: 'confirm' })).toEqual({ type: 'action', actionId: 'a', choice: 'confirm', label: undefined });
    expect(parseAgentRequest({ type: 'tool', tool: 'log_time', args: { day: '2026-10-07' } })).toMatchObject({ type: 'tool', tool: 'log_time' });
  });
  it.each([null, {}, { type: 'message' }, { type: 'action', actionId: 'a' }, { type: 'tool', tool: 'x', args: [] }, { type: 'drop' }])('rejects %j', (body) => {
    expect(() => parseAgentRequest(body)).toThrow('Send {type');
  });
});

describe('clientToday', () => {
  const now = new Date('2026-10-08T01:30:00Z'); // still Oct 7 in California
  it("uses the browser's local date when it is within a day of the server's", () => {
    expect(clientToday('2026-10-07', now)).toBe('2026-10-07');
    expect(clientToday('2026-10-09', now)).toBe('2026-10-09');
  });
  it("falls back to the server's UTC date for anything else", () => {
    expect(clientToday(undefined, now)).toBe('2026-10-08');
    expect(clientToday('2026-10-01', now)).toBe('2026-10-08');
    expect(clientToday('2026-02-30', now)).toBe('2026-10-08');
    expect(clientToday('soon', now)).toBe('2026-10-08');
  });
});

describe('handleAgentHttp', () => {
  it('requires a bearer token', async () => {
    const res = await handleAgentHttp(new Request('http://x/api/agent', { method: 'POST', body: '{}' }), { decider: null, llm: null, threshold: 0.9 });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in first', code: 'UNAUTHENTICATED' });
  });
});
