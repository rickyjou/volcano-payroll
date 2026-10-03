import type { VolcanoAuth } from '@volcano.dev/sdk';
import { nextAttemptAt, signWebhook } from '../lib/signing';
import { rows } from './db';

interface Delivery { id: string; endpoint_id: string; event: string; payload: unknown; attempts: number }
interface Endpoint { id: string; url: string; secret: string; active: boolean }
export interface AttemptResult { ok: boolean; code: number | null; error: string | null }
export interface DispatchSummary { delivered: number; retrying: number; failed: number }

export interface DispatchOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  limit?: number;
  /** Plain-http targets are refused unless PAYROLL_ALLOW_HTTP_WEBHOOKS=true (local testing only). */
  allowHttp?: boolean;
}

export async function deliverOnce(ep: Endpoint, d: Delivery, now: Date, fetchImpl: typeof fetch, allowHttp: boolean): Promise<AttemptResult> {
  if (!ep.active) return { ok: false, code: null, error: 'Endpoint is inactive' };
  if (!allowHttp && !ep.url.startsWith('https://')) return { ok: false, code: null, error: 'Webhook URLs must use https' };
  const body = JSON.stringify(d.payload);
  try {
    const res = await fetchImpl(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'payroll-webhooks/1',
        'X-Payroll-Event': d.event,
        'X-Payroll-Delivery': d.id,
        'X-Payroll-Signature': signWebhook(ep.secret, body, Math.floor(now.getTime() / 1000)),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return res.status >= 200 && res.status < 300
      ? { ok: true, code: res.status, error: null }
      : { ok: false, code: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, code: null, error: String((e as Error).message ?? e).slice(0, 500) };
  }
}

/** Sends every pending delivery that is due, recording the outcome and scheduling retries. Needs a service client. */
export async function dispatchDue(db: VolcanoAuth, opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowHttp = opts.allowHttp ?? process.env.PAYROLL_ALLOW_HTTP_WEBHOOKS === 'true';
  const summary: DispatchSummary = { delivered: 0, retrying: 0, failed: 0 };

  const due = await rows<Delivery>(db.from('webhook_deliveries').select('id,endpoint_id,event,payload,attempts')
    .eq('status', 'pending').lte('next_attempt_at', now.toISOString()).order('next_attempt_at').limit(opts.limit ?? 50));
  if (due.length === 0) return summary;
  const endpoints = new Map((await rows<Endpoint>(db.from('webhook_endpoints').select('id,url,secret,active')
    .in('id', [...new Set(due.map((d) => d.endpoint_id))]))).map((e) => [e.id, e]));

  for (const d of due) {
    const ep = endpoints.get(d.endpoint_id);
    const r = ep ? await deliverOnce(ep, d, now, fetchImpl, allowHttp) : { ok: false, code: null, error: 'Endpoint deleted' };
    const attempts = d.attempts + 1;
    if (r.ok) {
      summary.delivered++;
      await rows(db.update('webhook_deliveries', {
        status: 'delivered', attempts, delivered_at: now.toISOString(), last_response_code: r.code, last_error: null,
      }).eq('id', d.id));
      continue;
    }
    const next = nextAttemptAt(attempts, now);
    if (next) summary.retrying++; else summary.failed++;
    await rows(db.update('webhook_deliveries', {
      status: next ? 'pending' : 'failed', attempts, next_attempt_at: (next ?? now).toISOString(),
      last_response_code: r.code, last_error: r.error,
    }).eq('id', d.id));
  }
  return summary;
}
