import { describe, expect, it } from 'vitest';
import { parseEmployeeCsv } from '../../src/lib/employee-import';

const HEADER = 'email,first_name,last_name,external_id,role,manager_email,hire_date,work_state,pay_type,rate,effective_from';

describe('parseEmployeeCsv', () => {
  it('parses and normalises a valid row', () => {
    const r = parseEmployeeCsv(`${HEADER}\n  Ada@Example.COM ,Ada,Lovelace,E1,Manager,BOSS@x.com,2024-01-15,ca,Hourly,"$1,025.50",\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{
      line: 2, email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', external_id: 'E1',
      role: 'manager', manager_email: 'boss@x.com', hire_date: '2024-01-15', work_state: 'CA',
      pay_type: 'hourly', rate_cents: 102_550, effective_from: '2024-01-15',
    }]);
  });

  it('accepts minimal columns in any order and defaults the role', () => {
    const r = parseEmployeeCsv('Last_Name,hire_date,EMAIL,first_name\nHopper,2020-02-29,g@x.com,Grace');
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ email: 'g@x.com', role: 'employee', pay_type: null, rate_cents: null, effective_from: null });
  });

  it('reports every problem with its line number and skips bad rows', () => {
    const r = parseEmployeeCsv([
      HEADER,
      'a@x.com,A,One,,,,2024-01-01,,,,',
      'A@X.com,B,Two,,,,2024-01-01,,,,',
      'bad-email,,Three,,boss,,2024-02-30,California,weekly,abc,',
      'c@x.com,C,Four,,,c@x.com,2024-01-01,,salary,,',
      '',
    ].join('\n'));
    expect(r.rows.map((x) => x.email)).toEqual(['a@x.com']);
    expect(r.errors).toEqual([
      { line: 3, message: 'duplicate email a@x.com (also on line 2)' },
      { line: 4, message: 'invalid email "bad-email"' },
      { line: 4, message: 'first_name is required' },
      { line: 4, message: 'role must be one of employee, manager, admin' },
      { line: 4, message: 'hire_date must be YYYY-MM-DD (got "2024-02-30")' },
      { line: 4, message: 'work_state must be a 2-letter code (got "CALIFORNIA")' },
      { line: 4, message: 'pay_type must be one of salary, hourly, daily' },
      { line: 4, message: 'rate must be a dollar amount (got "abc")' },
      { line: 5, message: 'an employee cannot be their own manager' },
      { line: 5, message: 'pay_type and rate must be given together' },
    ]);
  });

  it('rejects missing or unknown columns', () => {
    expect(parseEmployeeCsv('email,first_name\nx@y.z,X').errors).toEqual([{ line: 1, message: 'Missing required column(s): last_name, hire_date' }]);
    expect(parseEmployeeCsv('email,first_name,last_name,hire_date,salary\n').errors).toEqual([{ line: 1, message: 'Unknown column(s): salary' }]);
    expect(parseEmployeeCsv('').errors).toEqual([{ line: 0, message: 'The file is empty' }]);
  });
});
