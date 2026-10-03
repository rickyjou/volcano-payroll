import type { VolcanoAuth } from '@volcano.dev/sdk';
import type { Role } from '../lib/employee-import';
import { rows } from './db';
import { HttpError, type VolcanoAuthContext } from './http';

export interface Me {
  id: string;
  role: Role;
  first_name: string;
  last_name: string;
  email: string;
}

/** The caller's active employee row (read under RLS with their own token). */
export async function requireEmployee(db: VolcanoAuth, auth: VolcanoAuthContext, roles?: Role[]): Promise<Me> {
  const [me] = await rows<Me>(
    db.from('employees').select('id,role,first_name,last_name,email').eq('user_id', auth.user_id).eq('status', 'active').limit(1),
  );
  if (!me) throw new HttpError(403, 'NOT_INVITED', 'No active employee record is linked to this account');
  if (roles && !roles.includes(me.role)) throw new HttpError(403, 'FORBIDDEN', `This needs the ${roles.join(' or ')} role`);
  return me;
}

/**
 * Volcano issues a session at sign-up before the email is confirmed, so an
 * unconfirmed address must never claim an employee record. Local stacks send
 * no email, hence the explicit opt-out (never set it in the cloud).
 */
export function assertEmailConfirmed(user: { email_confirmed?: boolean }, allowUnconfirmed: boolean): void {
  if (user.email_confirmed !== true && !allowUnconfirmed) {
    throw new HttpError(403, 'EMAIL_NOT_CONFIRMED', 'Confirm your email address, then sign in again');
  }
}
