'use client';
import type { ReactNode } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted" role="status" aria-live="polite">{label}</p>;
}

export function ErrorBanner({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <span>{error}</span>
      {onRetry && <button type="button" className="secondary small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="alert info" role="status">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

const BADGE: Record<string, string> = {
  draft: 'neutral', open: 'ok', submitted: 'warn', locked: 'warn', approved: 'ok', finalized: 'ok',
  rejected: 'bad', voided: 'bad', terminated: 'bad', active: 'ok', pending: 'warn', delivered: 'ok', failed: 'bad',
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${BADGE[value] ?? 'neutral'}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
