'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { Role } from '../../src/lib/employee-import';
import { useSession } from '../lib/session';
import { Loading } from './ui';

const LINKS: { href: string; label: string; roles: Role[] }[] = [
  { href: '/portal', label: 'My timesheet', roles: ['employee', 'manager', 'admin'] },
  { href: '/portal/history', label: 'History', roles: ['employee', 'manager', 'admin'] },
  { href: '/manage', label: 'Approvals', roles: ['manager', 'admin'] },
  { href: '/admin/employees', label: 'Employees', roles: ['admin'] },
  { href: '/admin/periods', label: 'Pay periods', roles: ['admin'] },
  { href: '/admin/runs', label: 'Payroll runs', roles: ['admin'] },
  { href: '/admin/integrations', label: 'Integrations', roles: ['admin'] },
  { href: '/admin/settings', label: 'Settings', roles: ['admin'] },
];

/** Signed-in layout with role-based navigation. RLS is the real enforcement; this only hides what a role can't use. */
export function AppShell({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { status, employee, linkError, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'signed_out') router.replace('/login');
  }, [status, router]);

  if (status === 'loading' || status === 'signed_out') return <main className="page"><Loading /></main>;
  if (status === 'unlinked' || !employee) {
    return (
      <main className="page narrow">
        <h1>Your account isn&apos;t set up yet</h1>
        <p role="alert">{linkError}</p>
        <button type="button" onClick={() => void signOut()}>Sign out</button>
      </main>
    );
  }

  const links = LINKS.filter((l) => l.roles.includes(employee.role));
  return (
    <>
      <header className="topbar">
        <nav aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>{l.label}</Link>
          ))}
        </nav>
        <div className="who">
          <span>{employee.first_name} {employee.last_name}</span>
          <button type="button" className="secondary small" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>
      <main className="page">
        {roles.includes(employee.role) ? children : (
          <>
            <h1>No access</h1>
            <p>This page is for {roles.join(' / ')} users. <Link href="/portal">Go to your timesheet</Link>.</p>
          </>
        )}
      </main>
    </>
  );
}
