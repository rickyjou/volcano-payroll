'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '../components/ui';
import { homeFor, useSession } from '../lib/session';

export default function Home() {
  const { status, employee } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'ready' && employee) router.replace(homeFor(employee.role));
    else if (status === 'signed_out' || status === 'unlinked') router.replace('/login');
  }, [status, employee, router]);
  return <main className="page"><Loading /></main>;
}
