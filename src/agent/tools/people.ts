// Admin people tools: find, add, update and terminate employees and set their pay.
// Adding goes through the employee-import Function so it gets the same validation.
import { dollarsToCents } from '../../lib/money';
import { rows } from '../../server/db';
import { changed, fullName, getEmployee, listEmployees, type EmployeeRow } from '../queries';
import { Refusal, type AgentTool } from '../types';
import { CONFIRM_CHOICES, DANGER_CHOICES, dayLabel, money } from './common';

const ADMIN = ['admin'] as const;
const ROLE = { enum: ['employee', 'manager', 'admin'] } as const;
const PAY_TYPE = { enum: ['salary', 'hourly', 'daily'] } as const;
const UNIT = { salary: 'per year', hourly: 'per hour', daily: 'per day' } as const;

const describe = (e: EmployeeRow) =>
  `${fullName(e)} <${e.email}> — ${e.role}, ${e.status}${e.termination_date ? ` (left ${e.termination_date})` : ''}, hired ${e.hire_date}${e.external_id ? `, ID ${e.external_id}` : ''}`;

export const findEmployee: AgentTool = {
  name: 'find_employee',
  roles: [...ADMIN],
  description: 'look up an employee by name or email and show their details and pay',
  kind: 'read',
  args: {
    employee: { type: 'uuid', slot: 'employee', description: 'The employee, when known' },
    query: { type: 'string', description: 'Part of a name or email to search for' },
  },
  async run(ctx, a) {
    if (typeof a.employee === 'string') {
      const e = await getEmployee(ctx.db, a.employee);
      const comp = await rows<{ pay_type: keyof typeof UNIT; rate_cents: number; effective_from: string }>(ctx.db.from('compensation')
        .select('pay_type,rate_cents,effective_from').eq('employee_id', e.id).order('effective_from', { ascending: false }).limit(5));
      return {
        text: describe(e) + '.',
        cards: comp.length ? [{ kind: 'table', title: `${fullName(e)} — pay history`, columns: ['From', 'Type', 'Rate'], rows: comp.map((c) => [String(c.effective_from).slice(0, 10), c.pay_type, `${money(Number(c.rate_cents))} ${UNIT[c.pay_type]}`]) }] : [],
        data: { employee: e, pay: comp },
      };
    }
    const q = String(a.query ?? '').toLowerCase();
    const found = (await listEmployees(ctx.db)).filter((e) => !q || `${fullName(e)} ${e.email}`.toLowerCase().includes(q)).slice(0, 25);
    if (found.length === 0) return { text: `No employee matches "${a.query}".`, data: [] };
    return {
      text: `${found.length} match${found.length === 1 ? '' : 'es'}.`,
      cards: [{ kind: 'table', title: 'Employees', columns: ['Name', 'Email', 'Role', 'Status'], rows: found.map((e) => [fullName(e), e.email, e.role, e.status]) }],
      data: found.map((e) => ({ employee: e.id, name: fullName(e), email: e.email, role: e.role, status: e.status })),
    };
  },
};

export const addEmployee: AgentTool = {
  name: 'add_employee',
  roles: [...ADMIN],
  description: 'invite a new employee (they can then create an account with this email)',
  kind: 'write',
  args: {
    email: { type: 'string', required: true, description: 'Work email' },
    first_name: { type: 'string', required: true, description: 'First name' },
    last_name: { type: 'string', required: true, description: 'Last name' },
    hire_date: { type: 'date', required: true, description: 'Hire date' },
    role: { type: ROLE, description: 'Role (default employee)' },
    manager_email: { type: 'string', description: "Their manager's email" },
    work_state: { type: 'string', description: 'Two-letter work state, e.g. CA' },
    external_id: { type: 'string', description: "The payroll provider's employee ID" },
    pay_type: { type: PAY_TYPE, description: 'salary, hourly or daily (give with rate)' },
    rate: { type: 'number', description: 'Dollars per year, hour or day (give with pay_type)' },
  },
  async confirm(_ctx, a) {
    if (!!a.pay_type !== (a.rate != null)) throw new Refusal('Give both a pay type and a rate, or neither.');
    return {
      title: `Add ${a.first_name} ${a.last_name}?`,
      lines: [
        `${a.email}, ${a.role ?? 'employee'}, hired ${a.hire_date}`,
        ...(a.manager_email ? [`Manager: ${a.manager_email}`] : []),
        ...(a.pay_type ? [`Pay: ${a.pay_type}, $${a.rate} ${UNIT[a.pay_type as keyof typeof UNIT]}`] : ['No pay set yet']),
      ],
      choices: CONFIRM_CHOICES,
    };
  },
  async run(ctx, a) {
    const values: Record<string, string> = {};
    for (const k of ['email', 'first_name', 'last_name', 'hire_date', 'role', 'manager_email', 'work_state', 'external_id', 'pay_type']) {
      if (a[k] != null) values[k] = String(a[k]);
    }
    if (a.rate != null) values.rate = String(a.rate);
    const r = await ctx.invoke<{ created: number; updated: number; outcomes: { result: string; message?: string }[] }>('employee-import', { records: [{ line: 1, values }] });
    const o = r.outcomes[0];
    if (!o || o.result === 'error') throw new Refusal(`Could not add them: ${o?.message ?? 'unknown error'}.`);
    return {
      text: `${o.result === 'created' ? 'Added' : 'Updated'} ${a.first_name} ${a.last_name}. They can now create an account with ${a.email}.${o.message ? ` Note: ${o.message}.` : ''}`,
      changed: ['employees'],
    };
  },
};

export const updateEmployee: AgentTool = {
  name: 'update_employee',
  roles: [...ADMIN],
  description: "change an employee's name, email, role, manager, work state or provider ID",
  kind: 'write',
  args: {
    employee: { type: 'uuid', required: true, slot: 'employee', description: 'The employee' },
    first_name: { type: 'string', description: 'New first name' },
    last_name: { type: 'string', description: 'New last name' },
    email: { type: 'string', description: 'New email' },
    role: { type: ROLE, description: 'New role' },
    manager: { type: 'uuid', description: 'New manager (employee id)' },
    work_state: { type: 'string', description: 'New two-letter work state' },
    external_id: { type: 'string', description: 'New provider employee ID' },
  },
  async confirm(ctx, a) {
    const e = await getEmployee(ctx.db, a.employee as string);
    const changes = updates(a);
    if (Object.keys(changes).length === 0) throw new Refusal('Tell me what to change.');
    return {
      title: `Update ${fullName(e)}?`,
      lines: Object.entries(changes).map(([k, v]) => `${k.replace('_id', '')}: ${String((e as unknown as Record<string, unknown>)[k] ?? '—')} → ${v}`),
      choices: CONFIRM_CHOICES,
    };
  },
  async run(ctx, a) {
    const e = await getEmployee(ctx.db, a.employee as string);
    await changed(ctx.db.update('employees', updates(a)).eq('id', e.id), fullName(e));
    return { text: `Updated ${fullName(e)}.`, changed: ['employees'] };
  },
};

function updates(a: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['first_name', 'last_name', 'role', 'external_id'] as const) if (a[k] != null) out[k] = String(a[k]);
  if (a.email != null) out.email = String(a.email).trim().toLowerCase();
  if (a.work_state != null) out.work_state = String(a.work_state).toUpperCase();
  if (a.manager != null) out.manager_id = String(a.manager);
  return out;
}

export const terminateEmployee: AgentTool = {
  name: 'terminate_employee',
  roles: [...ADMIN],
  description: 'record that an employee has left, with their last day',
  kind: 'write',
  args: {
    employee: { type: 'uuid', required: true, slot: 'employee', description: 'The employee' },
    date: { type: 'date', required: true, slot: 'day', description: 'Their last day' },
  },
  async confirm(ctx, a) {
    const e = await getEmployee(ctx.db, a.employee as string);
    if (e.status === 'terminated') throw new Refusal(`${fullName(e)} has already left (${e.termination_date}).`);
    return { title: `Terminate ${fullName(e)}, last day ${dayLabel(a.date as string)}?`, lines: ['They can no longer sign in. Their last month can still be approved and paid.'], choices: DANGER_CHOICES };
  },
  async run(ctx, a) {
    const e = await getEmployee(ctx.db, a.employee as string);
    await changed(ctx.db.update('employees', { status: 'terminated', termination_date: a.date as string }).eq('id', e.id), fullName(e));
    return { text: `${fullName(e)} is recorded as having left on ${dayLabel(a.date as string)}.`, changed: ['employees'] };
  },
};

export const setPay: AgentTool = {
  name: 'set_pay',
  roles: [...ADMIN],
  description: "set an employee's pay type and rate from a date (a raise or a change of pay type)",
  kind: 'write',
  args: {
    employee: { type: 'uuid', required: true, slot: 'employee', description: 'The employee' },
    pay_type: { type: PAY_TYPE, required: true, description: 'salary, hourly or daily' },
    rate: { type: 'number', required: true, description: 'Dollars per year (salary), hour (hourly) or day (daily)' },
    effective_from: { type: 'date', required: true, slot: 'day', description: 'First day the new pay applies' },
  },
  async confirm(ctx, a) {
    const e = await getEmployee(ctx.db, a.employee as string);
    const cents = rateCents(a.rate);
    return {
      title: `Set ${fullName(e)}'s pay?`,
      lines: [`${a.pay_type}, ${money(cents)} ${UNIT[a.pay_type as keyof typeof UNIT]}, from ${dayLabel(a.effective_from as string)}`],
      choices: CONFIRM_CHOICES,
    };
  },
  async run(ctx, a) {
    const e = await getEmployee(ctx.db, a.employee as string);
    const comp = { employee_id: e.id, pay_type: a.pay_type as string, rate_cents: rateCents(a.rate), effective_from: a.effective_from as string };
    const [same] = await rows<{ id: string }>(ctx.db.from('compensation').select('id').eq('employee_id', e.id).eq('effective_from', comp.effective_from));
    if (same) await changed(ctx.db.update('compensation', comp).eq('id', same.id), `${fullName(e)}'s pay`);
    else await rows(ctx.db.insert('compensation', comp));
    return { text: `${fullName(e)}'s pay is ${comp.pay_type}, ${money(comp.rate_cents)} ${UNIT[comp.pay_type as keyof typeof UNIT]} from ${dayLabel(comp.effective_from)}.`, changed: ['employees'] };
  },
};

function rateCents(rate: unknown): number {
  try {
    const cents = dollarsToCents(String(rate));
    if (cents > 0) return cents;
  } catch {
    // fall through
  }
  throw new Refusal(`"${rate}" isn't a valid rate. Use dollars, e.g. 32.50.`);
}

export const PEOPLE_TOOLS = [findEmployee, addEmployee, updateEmployee, terminateEmployee, setPay];
