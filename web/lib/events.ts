'use client';
// The chat agent changes data behind a page's back; pages reload when it says so.
import { useEffect, useRef } from 'react';

const EVENT = 'payroll:data-changed';

export function emitDataChanged(areas: string[]): void {
  if (areas.length) window.dispatchEvent(new CustomEvent(EVENT, { detail: areas }));
}

/** Calls `reload` whenever the agent reports a data change, with the areas that changed. */
export function useDataChanged(reload: (areas: string[]) => unknown): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const on = (e: Event) => void latest.current((e as CustomEvent<string[]>).detail ?? []);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
