import { HttpError, fromDbError } from './http';

interface Result { data: unknown; error: Error | null }

/** Awaits a query or mutation; throws a mapped HttpError on failure. */
export async function rows<T>(q: PromiseLike<Result>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw fromDbError(error);
  return (data ?? []) as T[];
}

export async function one<T>(q: PromiseLike<Result>, notFound = 'Not found'): Promise<T> {
  const [row] = await rows<T>(q);
  if (!row) throw new HttpError(404, 'NOT_FOUND', notFound);
  return row;
}

/** RLS silently filters writes, so a mutation that touched nothing means "not allowed / not found". */
export async function mutated<T>(q: PromiseLike<Result>, what: string): Promise<T[]> {
  const out = await rows<T>(q);
  if (out.length === 0) throw new HttpError(403, 'FORBIDDEN', `Not allowed to change ${what}, or it does not exist`);
  return out;
}

/** Pages through a query that must apply `.limit(limit).offset(offset)`. */
export async function selectAll<T>(page: (offset: number, limit: number) => PromiseLike<Result>, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += size) {
    const batch = await rows<T>(page(offset, size));
    out.push(...batch);
    if (batch.length < size) return out;
  }
}

/** JSONB columns must be written as JSON text; they read back as parsed values. */
export const asJson = (v: unknown): string => JSON.stringify(v);

/** NUMERIC columns read back as strings. */
export const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** DATE columns: keep the YYYY-MM-DD part whatever the API returns. */
export const isoDate = (v: unknown): string => String(v).slice(0, 10);

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
