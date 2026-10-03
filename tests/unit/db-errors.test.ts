import { describe, expect, it } from 'vitest';
import { parseDbError } from '../../src/lib/db-errors';

describe('parseDbError', () => {
  it('maps guard errors', () => {
    expect(parseDbError('Query failed: ERROR: CONFLICT:OUTSIDE_PERIOD: 2026-10-07 is outside this pay period (SQLSTATE P0001)'))
      .toEqual({ status: 409, code: 'OUTSIDE_PERIOD', message: '2026-10-07 is outside this pay period' });
    expect(parseDbError('Query failed: ERROR: FORBIDDEN:ADMIN_ONLY: only admins can change payroll runs (SQLSTATE P0001)'))
      .toEqual({ status: 403, code: 'ADMIN_ONLY', message: 'only admins can change payroll runs' });
  });
  it('maps constraint errors', () => {
    expect(parseDbError('ERROR: duplicate key value violates unique constraint "employees_email_key"').code).toBe('DUPLICATE');
    expect(parseDbError('ERROR: new row for relation "time_entries" violates check constraint "x"').status).toBe(400);
  });
  it('passes anything else through as 500', () => {
    expect(parseDbError('Query failed')).toEqual({ status: 500, code: 'DB_ERROR', message: 'Query failed' });
  });
});
