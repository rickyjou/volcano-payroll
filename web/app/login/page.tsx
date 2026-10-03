'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBanner, Field, Notice } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { homeFor, useSession } from '../../lib/session';

const MIN_PASSWORD = 15;

export default function LoginPage() {
  const { status, employee, linkError, signIn, signUp, signOut } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'ready' && employee) router.replace(homeFor(employee.role));
  }, [status, employee, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (mode === 'signup' && password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, password);
      else {
        const { confirmationRequired } = await signUp(email, password);
        if (confirmationRequired) setNotice('Check your email for a confirmation link, then sign in.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(mode === 'signin' ? 'signup' : 'signin');
    setError(null);
    setNotice(null);
  }

  return (
    <main className="page narrow">
      <h1>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
      {mode === 'signup' && <p className="muted">Use the work email your administrator invited.</p>}
      {status === 'unlinked' && (
        <div className="alert error" role="alert">
          <span>{linkError}</span>
          <button type="button" className="secondary small" onClick={() => void signOut()}>Use another account</button>
        </div>
      )}
      <form onSubmit={submit} className="stack">
        <Field label="Work email">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint={mode === 'signup' ? `At least ${MIN_PASSWORD} characters` : undefined}>
          <input
            type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={mode === 'signup' ? MIN_PASSWORD : undefined}
          />
        </Field>
        <button type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      </form>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      <p className="muted">
        {mode === 'signin' ? 'First time here? ' : 'Already have an account? '}
        <button type="button" className="link" onClick={switchMode}>
          {mode === 'signin' ? 'Create your account' : 'Sign in'}
        </button>
      </p>
    </main>
  );
}
