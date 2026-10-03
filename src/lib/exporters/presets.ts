import type { Preset } from './types';

const VERIFY =
  "Starting point based on the provider's published import layout. Verify the column names and earning codes against your account's current import template before first use.";

export const PRESETS: Preset[] = [
  {
    key: 'generic_csv',
    name: 'Generic CSV (all fields)',
    note: 'One row per employee and earning code with every canonical field.',
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'YYYY-MM-DD',
      code_map: {},
      columns: [
        { header: 'Run ID', field: 'run_id' },
        { header: 'Period Start', field: 'period_start' },
        { header: 'Period End', field: 'period_end' },
        { header: 'Employee ID', field: 'external_id' },
        { header: 'First Name', field: 'first_name' },
        { header: 'Last Name', field: 'last_name' },
        { header: 'Email', field: 'email' },
        { header: 'Pay Type', field: 'pay_type' },
        { header: 'Work State', field: 'work_state' },
        { header: 'Earning Code', field: 'earning_code' },
        { header: 'Hours', field: 'hours' },
        { header: 'Days', field: 'days' },
        { header: 'Rate', field: 'rate' },
        { header: 'Amount', field: 'amount' },
      ],
    },
  },
  {
    key: 'generic_json',
    name: 'Generic JSON (schema v1)',
    note: 'Canonical run and lines as JSON; amounts in cents.',
    config: { format: 'json', row_mode: 'per_line', date_format: 'YYYY-MM-DD', code_map: {}, columns: [] },
  },
  {
    key: 'gusto',
    name: 'Gusto — hours import',
    note: VERIFY,
    config: {
      format: 'csv',
      row_mode: 'per_employee',
      date_format: 'MM/DD/YYYY',
      code_map: {},
      columns: [
        { header: 'Last Name', field: 'last_name' },
        { header: 'First Name', field: 'first_name' },
        { header: 'Email', field: 'email' },
        { header: 'Regular Hours', field: 'hours', code: 'REG' },
        { header: 'Overtime Hours', field: 'hours', code: 'OT' },
        { header: 'Double Overtime Hours', field: 'hours', code: 'DT' },
        { header: 'PTO Hours', field: 'hours', code: 'PTO' },
        { header: 'Sick Hours', field: 'hours', code: 'SICK' },
        { header: 'Holiday Hours', field: 'hours', code: 'HOL' },
      ],
    },
  },
  {
    key: 'adp_wfn',
    name: 'ADP Workforce Now — paydata import',
    note: `${VERIFY} Replace the Co Code and Batch ID constants with your values.`,
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'MM/DD/YYYY',
      code_map: { SAL: 'SAL', REG: 'REG', OT: 'OT', DT: 'DT', PTO: 'VAC', SICK: 'SCK', HOL: 'HOL' },
      columns: [
        { header: 'Co Code', const: 'CHANGE_ME' },
        { header: 'Batch ID', const: 'PAYROLL' },
        { header: 'File #', field: 'external_id' },
        { header: 'Hours 3 Code', field: 'earning_code' },
        { header: 'Hours 3 Amount', field: 'hours' },
        { header: 'Earnings 3 Code', field: 'earning_code' },
        { header: 'Earnings 3 Amount', field: 'amount' },
      ],
    },
  },
  {
    key: 'qbo_payroll',
    name: 'QuickBooks Online Payroll — time import',
    note: VERIFY,
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'MM/DD/YYYY',
      code_map: {
        SAL: 'Salary', REG: 'Hourly', OT: 'Overtime Hourly', DT: 'Double Overtime Hourly',
        PTO: 'Paid Time Off', SICK: 'Sick Pay', HOL: 'Holiday Pay',
      },
      columns: [
        { header: 'Employee', field: 'full_name' },
        { header: 'Pay Item', field: 'earning_code' },
        { header: 'Hours', field: 'hours' },
        { header: 'Amount', field: 'amount' },
        { header: 'Period Start', field: 'period_start' },
        { header: 'Period End', field: 'period_end' },
      ],
    },
  },
  {
    key: 'paychex_flex',
    name: 'Paychex Flex — earnings import',
    note: VERIFY,
    config: {
      format: 'csv',
      row_mode: 'per_line',
      date_format: 'MM/DD/YYYY',
      code_map: {
        SAL: 'Salary', REG: 'Regular', OT: 'Overtime', DT: 'Double Time',
        PTO: 'Vacation', SICK: 'Sick', HOL: 'Holiday',
      },
      columns: [
        { header: 'Worker ID', field: 'external_id' },
        { header: 'Last Name', field: 'last_name' },
        { header: 'First Name', field: 'first_name' },
        { header: 'Earning', field: 'earning_code' },
        { header: 'Hours', field: 'hours' },
        { header: 'Rate', field: 'rate' },
        { header: 'Amount', field: 'amount' },
      ],
    },
  },
];

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((p) => p.key === key);
}
