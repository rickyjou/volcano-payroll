'use client';
import { parseDbError } from '../../src/lib/db-errors';
import { getVolcano } from './volcano';

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) {
    super(message);
  }
}

interface Result { data: unknown; error: Error | null }

/** Awaits a query/mutation and returns its rows, throwing a readable ApiError on failure. */
export async function q<T>(query: PromiseLike<Result>): Promise<T[]> {
  const { data, error } = await query;
  if (error) {
    const p = parseDbError(error.message);
    throw new ApiError(p.message, p.code);
  }
  return (data ?? []) as T[];
}

/** Like q, but a write that matched no rows (RLS or a stale id) is an error. */
export async function write<T>(query: PromiseLike<Result>, what: string): Promise<T[]> {
  const out = await q<T>(query);
  if (out.length === 0) throw new ApiError(`Could not update ${what}. Refresh and try again.`, 'FORBIDDEN');
  return out;
}

/** Invokes a Volcano Function and returns its JSON body, throwing ApiError for non-200 responses. */
export async function invoke<T>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, status, error } = await getVolcano().functions.invoke<Record<string, unknown>, T>(name, payload as never);
  const body = (typeof data === 'string' ? safeJson(data) : data) as (T & { error?: string; code?: string; details?: unknown }) | null;
  if (status === 200 && body) return body;
  if (body && typeof body === 'object' && 'error' in body && body.error) throw new ApiError(body.error, body.code ?? 'ERROR', body.details);
  throw new ApiError(error?.message ?? `The ${name} service failed (status ${status ?? 'unknown'})`, 'FUNCTION_ERROR');
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return { error: s }; }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
