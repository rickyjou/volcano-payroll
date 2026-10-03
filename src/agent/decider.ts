// Decision-model adapter. The HTTP client speaks the Strands Decider `/v1/systemone`
// API (Jev uses the same shape): a state plus typed questions in, typed answers out.

export type DeciderQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string };

export type DeciderAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities?: Record<string, number> }
  | { type: 'noul'; noul: number };

export interface Decider {
  decide(state: string, questions: Record<string, DeciderQuestion>): Promise<Record<string, DeciderAnswer>>;
}

export interface HttpDeciderOptions {
  url: string;
  token?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpDecider implements Decider {
  constructor(private readonly opts: HttpDeciderOptions) {}

  async decide(state: string, questions: Record<string, DeciderQuestion>): Promise<Record<string, DeciderAnswer>> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.url.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify({ state, questions, ...(this.opts.model ? { model: this.opts.model } : {}) }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2000),
    });
    if (!res.ok) throw new Error(`Decider returned HTTP ${res.status}`);
    const body = (await res.json()) as { answers?: Record<string, DeciderAnswer> };
    if (!body.answers || typeof body.answers !== 'object') throw new Error('Decider response has no answers');
    return body.answers;
  }
}

/** The chosen option when it is at least `threshold` confident, else null. */
export function picked(answers: Record<string, DeciderAnswer> | null, name: string, threshold: number): { value: string; confidence: number } | null {
  const a = answers?.[name];
  if (!a || a.type !== 'choice' || a.confidence < threshold) return null;
  return { value: a.choice, confidence: a.confidence };
}

/** Probability of a yes/no question, or null when it was not asked. */
export function probability(answers: Record<string, DeciderAnswer> | null, name: string): number | null {
  const a = answers?.[name];
  return a && a.type === 'noul' ? a.noul : null;
}
