// Database errors arrive as e.g.
//   "Query failed: ERROR: CONFLICT:OUTSIDE_PERIOD: 2026-10-07 is outside this pay period (SQLSTATE P0001)"
// Guards in the migrations raise CONFLICT:<CODE>: / FORBIDDEN:<CODE>: messages.

export interface ParsedDbError { status: number; code: string; message: string }

const GUARD = /(CONFLICT|FORBIDDEN):([A-Z_]+): (.+?)(?: \(SQLSTATE [0-9A-Z]+\))?$/;

export function parseDbError(raw: string): ParsedDbError {
  const m = GUARD.exec(raw);
  if (m) return { status: m[1] === 'CONFLICT' ? 409 : 403, code: m[2], message: m[3] };
  if (/duplicate key|unique constraint/i.test(raw)) return { status: 409, code: 'DUPLICATE', message: 'That record already exists' };
  if (/violates check constraint/i.test(raw)) return { status: 400, code: 'INVALID', message: 'One of the values is not allowed' };
  if (/violates foreign key constraint/i.test(raw)) return { status: 409, code: 'IN_USE', message: 'This record is referenced by other data' };
  return { status: 500, code: 'DB_ERROR', message: raw };
}
