import { parseDbError } from '../lib/db-errors';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const fromDbError = (err: Error): HttpError => {
  const p = parseDbError(err.message);
  return new HttpError(p.status, p.code, p.message);
};

export interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const ok = (body: unknown): FunctionResponse => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });

export function errorResponse(err: unknown): FunctionResponse {
  if (err instanceof HttpError) {
    return { statusCode: err.status, headers: JSON_HEADERS, body: JSON.stringify({ error: err.message, code: err.code, details: err.details }) };
  }
  console.error(err);
  return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Internal error', code: 'INTERNAL' }) };
}

export interface VolcanoAuthContext {
  user_id: string;
  email: string;
  access_token: string;
  project_id?: string;
  role?: string;
}

export type FunctionEvent = Record<string, unknown> & { __volcano_auth?: VolcanoAuthContext; __volcano_schedule?: unknown };

export function authOf(event: FunctionEvent): VolcanoAuthContext {
  const a = event.__volcano_auth;
  if (!a?.access_token || !a.user_id) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');
  return a;
}

/** Wraps a handler: normalises the event, returns 200 JSON on success and mapped errors otherwise. */
export function handle(fn: (event: FunctionEvent) => Promise<unknown>) {
  return async (event: unknown): Promise<FunctionResponse> => {
    try {
      return ok(await fn((event && typeof event === 'object' && !Array.isArray(event) ? event : {}) as FunctionEvent));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'BAD_REQUEST', `${name} is required`);
  return v.trim();
}
