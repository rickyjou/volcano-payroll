// HTTP entry for the chat agent (used by web/app/api/agent/route.ts). Verifies the
// caller's Volcano session, then runs the turn as that user. Never uses the service key.
import { fromUtc, toUtc, type ISODate } from '../lib/dates';
import { requireEmployee } from '../server/auth';
import { HttpError } from '../server/http';
import { userClient } from '../server/volcano';
import { handleAgentRequest, MAX_MESSAGE, type AgentRequest } from './agent';
import { HttpDecider, type Decider } from './decider';
import { OpenAiCompatibleLlm, type Llm } from './llm';
import { RuleDecider } from './rule-decider';
import { DEFAULT_THRESHOLD } from './router';

type Env = Record<string, string | undefined>;

export interface AgentConfig { decider: Decider | null; llm: Llm | null; threshold: number }

/**
 * Server-only variables: DECIDER_URL/TOKEN/MODEL, LLM_URL/TOKEN/MODEL, AGENT_DECIDER_THRESHOLD.
 * Without DECIDER_URL the built-in keyword rules decide, so routine requests need no model.
 */
export function agentConfigFromEnv(env: Env): AgentConfig {
  const threshold = Number(env.AGENT_DECIDER_THRESHOLD);
  return {
    decider: env.DECIDER_URL ? new HttpDecider({ url: env.DECIDER_URL, token: env.DECIDER_TOKEN || undefined, model: env.DECIDER_MODEL || undefined }) : new RuleDecider(),
    llm: env.LLM_URL && env.LLM_MODEL ? new OpenAiCompatibleLlm({ url: env.LLM_URL, model: env.LLM_MODEL, token: env.LLM_TOKEN || undefined }) : null,
    threshold: threshold > 0 && threshold <= 1 ? threshold : DEFAULT_THRESHOLD,
  };
}

/** Checks the request body shape; anything else is a 400. */
export function parseAgentRequest(body: unknown): AgentRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  // Labels and page names are echoed into history and prompts, so keep them short.
  const str = (k: string, max = 200) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, max) : undefined);
  switch (b.type) {
    case 'history':
      return { type: 'history' };
    case 'message':
      if (!str('text')) break;
      return { type: 'message', text: str('text', MAX_MESSAGE)!, page: str('page') };
    case 'action':
      if (!str('actionId') || !str('choice')) break;
      return { type: 'action', actionId: str('actionId')!, choice: str('choice')!, label: str('label') };
    case 'tool':
      if (!str('tool') || !b.args || typeof b.args !== 'object' || Array.isArray(b.args)) break;
      return { type: 'tool', tool: str('tool')!, args: b.args as Record<string, unknown>, label: str('label') };
  }
  throw new HttpError(400, 'BAD_REQUEST', 'Send {type: "history" | "message" | "action" | "tool", ...}');
}

/**
 * "Today" for the user: the browser's local date when it is within a day of the server's
 * UTC date (an evening in California is already tomorrow in UTC), else the UTC date.
 */
export function clientToday(v: unknown, now: Date): ISODate {
  const utc = fromUtc(now.getTime());
  if (typeof v !== 'string') return utc;
  try {
    return Math.abs(toUtc(v) - toUtc(utc)) <= 86_400_000 ? v : utc;
  } catch {
    return utc;
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleAgentHttp(request: Request, config: AgentConfig, now = new Date()): Promise<Response> {
  try {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
    const db = userClient(token);
    const { user, error } = await db.auth.getUser();
    if (error || !user) throw new HttpError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    const me = await requireEmployee(db, { user_id: user.id, email: user.email ?? '', access_token: token });
    const body = await request.json().catch(() => null);
    const req = parseAgentRequest(body);
    const today = clientToday((body as { today?: unknown } | null)?.today, now);
    return json(200, await handleAgentRequest({ db, userId: user.id, me, now, today, ...config }, req));
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code });
    console.error('agent request failed', err);
    return json(500, { error: 'The assistant failed. Please try again.', code: 'INTERNAL' });
  }
}
