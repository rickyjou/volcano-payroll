// Calls a deployed Volcano Function as the signed-in user and returns its JSON body.
// The Function's own role checks and the database guards apply as for the UI.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { HttpError } from '../server/http';

export function invoker(db: VolcanoAuth) {
  return async function invoke<T>(name: string, payload: Record<string, unknown>): Promise<T> {
    const { data, status, error } = await db.functions.invoke<Record<string, unknown>, T>(name, payload as never);
    const body = (typeof data === 'string' ? safeJson(data) : data) as (T & { error?: string; code?: string; details?: unknown }) | null;
    if (status === 200 && body) return body;
    if (body && typeof body === 'object' && body.error) throw new HttpError(status ?? 500, body.code ?? 'ERROR', body.error, body.details);
    throw new HttpError(status ?? 502, 'FUNCTION_ERROR', error?.message ?? `The ${name} service failed`);
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { error: s };
  }
}
