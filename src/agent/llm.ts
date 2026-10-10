// Generative-model adapter. v1 ships a client for OpenAI-compatible chat completions
// with tool calling; another wire format is one more class implementing `Llm`.
import type { TokenSource } from './bedrock-token';

export interface LlmToolCall { id: string; name: string; args: unknown }

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTool { name: string; description: string; parameters: Record<string, unknown> }

export interface LlmResult { text: string; toolCalls: LlmToolCall[] }

/** `timeoutMs` is what is left of the turn's budget; the client stops waiting then. */
export interface LlmRequest { messages: LlmMessage[]; tools: LlmTool[]; timeoutMs?: number }

export interface Llm {
  complete(req: LlmRequest): Promise<LlmResult>;
}

export interface OpenAiCompatibleOptions {
  url: string;
  model: string;
  /** A fixed bearer token, or a source of renewing ones (short-term Bedrock keys). */
  token?: string | TokenSource;
  timeoutMs?: number;
  /** Caps each reply; reasoning models spend part of it thinking. */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

interface WireToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export class OpenAiCompatibleLlm implements Llm {
  constructor(private readonly opts: OpenAiCompatibleOptions) {}

  async complete(req: LlmRequest): Promise<LlmResult> {
    const signal = AbortSignal.timeout(Math.min(this.opts.timeoutMs ?? 20_000, req.timeoutMs ?? Infinity));
    let res = await this.post(req, signal);
    // A renewing token may have been revoked or outlived its credentials: renew once and retry.
    if ((res.status === 401 || res.status === 403) && typeof this.opts.token === 'object') res = await this.post(req, signal, true);
    if (!res.ok) throw new Error(`LLM returned HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] } }[] };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error('LLM response has no message');
    return {
      text: withoutReasoning(msg.content ?? ''),
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
    };
  }

  private async post(req: LlmRequest, signal: AbortSignal, renew = false): Promise<Response> {
    const t = this.opts.token;
    const token = typeof t === 'object' ? await t.token({ renew }) : t;
    const f = this.opts.fetchImpl ?? fetch;
    return f(`${this.opts.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: req.messages.map(toWire),
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
        max_tokens: this.opts.maxTokens ?? 1024,
      }),
      signal,
    });
  }
}

/** Reasoning models (gpt-oss on Bedrock) put their thinking in the content; users shouldn't see it. */
export function withoutReasoning(s: string): string {
  return s.replace(/<reasoning>[\s\S]*?(<\/reasoning>|$)/g, '').trim();
}

function parseArgs(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function toWire(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    };
  }
  return { role: m.role, content: m.content };
}
