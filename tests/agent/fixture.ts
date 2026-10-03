// A fixed world for router tests and the decider evaluation: Wed 2026-10-07, October open,
// September locked with a draft run, Hal and Dee waiting for approval.
import type { AgentContext, Role } from '../../src/agent/types';

export const TODAY = '2026-10-07';
export const OCT = { id: '00000000-0000-4000-8000-000000000010', start_date: '2026-10-01', end_date: '2026-10-31', status: 'open' as const };
export const SEP = { id: '00000000-0000-4000-8000-000000000009', start_date: '2026-09-01', end_date: '2026-09-30', status: 'locked' as const };
export const HAL = { id: '00000000-0000-4000-8000-0000000000a1', employee_id: 'e-hal', name: 'Hal Hourly', period_id: OCT.id, status: 'submitted' };
export const DEE = { id: '00000000-0000-4000-8000-0000000000a2', employee_id: 'e-dee', name: 'Dee Daily', period_id: OCT.id, status: 'submitted' };
export const RUN = { id: '00000000-0000-4000-8000-0000000000f9', period_id: SEP.id, status: 'draft' as const };
export const PEOPLE = [
  { id: '00000000-0000-4000-8000-0000000000e1', name: 'Hal Hourly', email: 'hal@example.com', status: 'active' },
  { id: '00000000-0000-4000-8000-0000000000e2', name: 'Dee Daily', email: 'dee@example.com', status: 'active' },
  { id: '00000000-0000-4000-8000-0000000000e3', name: 'Mia Manager', email: 'mia@example.com', status: 'active' },
];

export function fixtureContext(role: Role): AgentContext {
  return {
    me: { id: 'me', role, first_name: 'Ada', last_name: 'Admin', email: 'ada@example.com' },
    today: TODAY,
    payType: 'hourly',
    periods: [OCT, SEP],
    current: OCT,
    pending: role === 'employee' ? [] : [HAL, DEE],
    people: role === 'admin' ? PEOPLE : [],
    runs: role === 'admin' ? [RUN] : [],
  };
}
