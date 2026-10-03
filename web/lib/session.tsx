'use client';
import type { User } from '@volcano.dev/sdk';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role } from '../../src/lib/employee-import';
import { ApiError, errorMessage, invoke } from './api';
import { getVolcano } from './volcano';

export interface Employee {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: Role;
  manager_id: string | null;
}

type Status = 'loading' | 'signed_out' | 'unlinked' | 'ready';

interface SessionValue {
  status: Status;
  user: User | null;
  employee: Employee | null;
  /** Why the account could not be linked (not invited, email not confirmed, …). */
  linkError: string | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ confirmationRequired: boolean }>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const link = useCallback(async (u: User | null) => {
    setUser(u);
    if (!u) {
      setEmployee(null);
      setStatus('signed_out');
      return;
    }
    try {
      const { employee: e } = await invoke<{ employee: Employee }>('employee-link');
      setEmployee(e);
      setLinkError(null);
      setStatus('ready');
    } catch (err) {
      setEmployee(null);
      setLinkError(err instanceof ApiError ? err.message : errorMessage(err));
      setStatus('unlinked');
    }
  }, []);

  useEffect(() => {
    const volcano = getVolcano();
    volcano.initialize().then(({ user: u }) => link(u)).catch(() => setStatus('signed_out'));
  }, [link]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user: u, error } = await getVolcano().auth.signIn({ email: email.trim().toLowerCase(), password });
    if (error) throw error;
    await link(u);
  }, [link]);

  const signUp = useCallback(async (email: string, password: string) => {
    const r = await getVolcano().auth.signUp({ email: email.trim().toLowerCase(), password, signInWhenAllowed: true });
    if (r.error) throw r.error;
    if (r.user) await link(r.user);
    return { confirmationRequired: r.confirmationRequired };
  }, [link]);

  const signOut = useCallback(async () => {
    await getVolcano().auth.signOut();
    await link(null);
  }, [link]);

  return (
    <SessionContext.Provider value={{ status, user, employee, linkError, signIn, signUp, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

export const homeFor = (role: Role): string => (role === 'admin' ? '/admin' : role === 'manager' ? '/manage' : '/portal');
