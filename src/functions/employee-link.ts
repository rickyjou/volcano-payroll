// Links the signed-in account to the invited employee record with the same email.
import { normalizeEmail } from '../lib/employee-import';
import { assertEmailConfirmed } from '../server/auth';
import { mutated, rows } from '../server/db';
import { HttpError, authOf, handle } from '../server/http';
import { serviceClient, userClient } from '../server/volcano';

const COLUMNS = 'id,user_id,email,first_name,last_name,role,status,manager_id';

interface EmployeeRow { id: string; user_id: string | null; email: string; first_name: string; last_name: string; role: string; status: string; manager_id: string | null }

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = serviceClient();

  const [linked] = await rows<EmployeeRow>(db.from('employees').select(COLUMNS).eq('user_id', auth.user_id).limit(1));
  if (linked) {
    if (linked.status !== 'active') throw new HttpError(403, 'TERMINATED', 'This employee record is no longer active');
    return { employee: linked };
  }

  const { user, error } = await userClient(auth.access_token).auth.getUser();
  if (error || !user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in again');
  assertEmailConfirmed(user, process.env.PAYROLL_ALLOW_UNCONFIRMED_EMAIL === 'true');

  const [match] = await rows<EmployeeRow>(db.from('employees').select(COLUMNS).eq('email', normalizeEmail(user.email)).limit(1));
  if (!match || match.status !== 'active') {
    throw new HttpError(403, 'NOT_INVITED', 'This email has not been invited. Ask your payroll administrator.');
  }
  if (match.user_id) throw new HttpError(409, 'ALREADY_LINKED', 'This employee record is already linked to another account');

  await mutated(db.update('employees', { user_id: auth.user_id }).eq('id', match.id).is('user_id', null), 'employee');
  return { employee: { ...match, user_id: auth.user_id } };
});
