// Generative-model adapter. v1 ships a client for OpenAI-compatible chat completions
// with tool calling; another wire format is one more class implementing `Llm`.

export interface LlmToolCall { id: string; name: string; args: unknown }

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTool { name: string; description: string; parameters: Record<string, unknown> }

export interface LlmResult { text: string; toolCalls: LlmToolCall[] }

export interface Llm {
  complete(req: { messages: LlmMessage[]; tools: LlmTool[] }): Promise<LlmResult>;
}

export interface OpenAiCompatibleOptions {
  url: string;
  model: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface WireToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export class OpenAiCompatibleLlm implements Llm {
  constructor(private readonly opts: OpenAiCompatibleOptions) {}

  async complete(req: { messages: LlmMessage[]; tools: LlmTool[] }): Promise<LlmResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: req.messages.map(toWire),
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`LLM returned HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] } }[] };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error('LLM response has no message');
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
    };
  }
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
