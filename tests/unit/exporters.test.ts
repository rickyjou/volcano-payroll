import { describe, expect, it } from 'vitest';
import { PRESETS, findPreset, render, validateMapping, type ExportLine, type ExportRun, type MappingConfig } from '../../src/lib/exporters';

const run: ExportRun = {
  id: 'run-1',
  period_start: '2026-09-01',
  period_end: '2026-09-30',
  finalized_at: '2026-10-01T12:00:00Z',
  totals: { employee_count: 2, gross_cents: 1_118_750, by_code: {} },
};

const base = { work_state: 'CA', pay_type: 'hourly' as const };
const lines: ExportLine[] = [
  { ...base, employee_id: 'e2', external_id: 'E-2', first_name: 'Grace', last_name: 'Hopper', email: 'g@x.com', earning_code: 'OT', hours: 5, days: null, rate_cents: 3750, amount_cents: 18_750 },
  { ...base, employee_id: 'e2', external_id: 'E-2', first_name: 'Grace', last_name: 'Hopper', email: 'g@x.com', earning_code: 'REG', hours: 40, days: null, rate_cents: 2500, amount_cents: 100_000 },
  { ...base, employee_id: 'e1', external_id: '=E-1', first_name: 'Ada', last_name: 'Lovelace, Countess', email: 'a@x.com', pay_type: 'salary', earning_code: 'SAL', hours: null, days: 22, rate_cents: 1_000_000, amount_cents: 1_000_000 },
];

describe('render', () => {
  it('renders the generic CSV per line, sorted, escaped and formula-guarded', () => {
    const out = render(run, lines, findPreset('generic_csv')!.config, 'generic_csv');
    expect(out.filename).toBe('payroll-2026-09-generic_csv.csv');
    expect(out.content_type).toBe('text/csv; charset=utf-8');
    expect(out.body).toBe([
      'Run ID,Period Start,Period End,Employee ID,First Name,Last Name,Email,Pay Type,Work State,Earning Code,Hours,Days,Rate,Amount',
      "run-1,2026-09-01,2026-09-30,E-2,Grace,Hopper,g@x.com,hourly,CA,REG,40.00,,25.00,1000.00",
      "run-1,2026-09-01,2026-09-30,E-2,Grace,Hopper,g@x.com,hourly,CA,OT,5.00,,37.50,187.50",
      "run-1,2026-09-01,2026-09-30,'=E-1,Ada,\"Lovelace, Countess\",a@x.com,salary,CA,SAL,,22.00,10000.00,10000.00",
      '',
    ].join('\r\n'));
  });

  it('pivots earning codes into columns per employee', () => {
    const out = render(run, lines, findPreset('gusto')!.config, 'gusto');
    expect(out.body.split('\r\n')).toEqual([
      'Last Name,First Name,Email,Regular Hours,Overtime Hours,Double Overtime Hours,PTO Hours,Sick Hours,Holiday Hours',
      'Hopper,Grace,g@x.com,40.00,5.00,,,,',
      '"Lovelace, Countess",Ada,a@x.com,,,,,,',
      '',
    ]);
  });

  it('maps codes and formats US dates', () => {
    const out = render(run, lines.slice(0, 1), findPreset('qbo_payroll')!.config, 'qbo_payroll');
    expect(out.body.split('\r\n')[1]).toBe('Grace Hopper,Overtime Hourly,5.00,187.50,09/01/2026,09/30/2026');
  });

  it('writes constants', () => {
    const out = render(run, lines.slice(1, 2), findPreset('adp_wfn')!.config, 'adp_wfn');
    expect(out.body.split('\r\n')[1]).toBe('CHANGE_ME,PAYROLL,E-2,REG,40.00,REG,1000.00');
  });

  it('renders canonical JSON', () => {
    const out = render(run, lines, findPreset('generic_json')!.config, 'generic_json');
    const doc = JSON.parse(out.body);
    expect(out.filename).toBe('payroll-2026-09-generic_json.json');
    expect(doc.schema_version).toBe(1);
    expect(doc.run.id).toBe('run-1');
    expect(doc.lines.map((l: { earning_code: string }) => l.earning_code)).toEqual(['REG', 'OT', 'SAL']);
    expect(doc.lines[0]).toMatchObject({ hours: 40, amount_cents: 100_000, rate_cents: 2500 });
  });

  it('refuses an invalid mapping', () => {
    const bad: MappingConfig = { format: 'csv', row_mode: 'per_line', date_format: 'YYYY-MM-DD', code_map: {}, columns: [] };
    expect(() => render(run, lines, bad, 'x')).toThrow('Add at least one column');
  });
});

describe('validateMapping', () => {
  it('accepts every preset', () => {
    for (const p of PRESETS) expect(validateMapping(p.config), p.key).toEqual([]);
  });

  it('explains each problem', () => {
    const c = {
      format: 'csv', row_mode: 'per_line', date_format: 'YYYY-MM-DD', code_map: { XYZ: 'x' },
      columns: [{ header: '', field: 'nope' }, { header: 'A', field: 'hours', const: '1' }, { header: 'B', field: 'hours', code: 'REG' }],
    } as unknown as MappingConfig;
    expect(validateMapping(c)).toEqual([
      'Unknown earning code "XYZ" in code map',
      'Column 1: header is required',
      'Column 1: unknown field "nope"',
      'Column 2: set exactly one of field or constant',
      'Column 3: earning code columns need per-employee rows',
    ]);
  });
});

describe('render warnings for pay the file does not carry', () => {
  const daily: ExportLine = { ...base, employee_id: 'e3', external_id: 'E-3', first_name: 'Dee', last_name: 'Daily', email: 'd@x.com', pay_type: 'daily', earning_code: 'REG', hours: null, days: 4.5, rate_cents: 25_000, amount_cents: 112_500 };

  it('warns when an hours-only preset drops day-rate and salary pay', () => {
    const out = render(run, [...lines, daily], findPreset('gusto')!.config, 'gusto');
    expect(out.warnings).toEqual([
      'Dee Daily: REG $1125.00 is not in this file',
      'Ada Lovelace, Countess: SAL $10000.00 is not in this file',
    ]);
  });

  it('has no warnings when every amount has a column', () => {
    expect(render(run, [...lines, daily], findPreset('generic_csv')!.config, 'generic_csv').warnings).toEqual([]);
    expect(render(run, [...lines, daily], findPreset('generic_json')!.config, 'generic_json').warnings).toEqual([]);
    expect(render(run, lines.slice(0, 2), findPreset('gusto')!.config, 'gusto').warnings).toEqual([]);
  });
});
