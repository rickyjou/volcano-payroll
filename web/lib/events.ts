'use client';
// The chat agent changes data behind a page's back; pages reload when it says so.
import { useEffect, useRef } from 'react';

const EVENT = 'payroll:data-changed';

export function emitDataChanged(areas: string[]): void {
  if (areas.length) window.dispatchEvent(new CustomEvent(EVENT, { detail: areas }));
}

/** Calls `reload` whenever the agent reports a data change. */
export function useDataChanged(reload: () => unknown): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const on = () => void latest.current();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
