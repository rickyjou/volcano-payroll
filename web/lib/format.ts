import { centsToDollars } from '../../src/lib/money';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (cents: number | string | null | undefined): string =>
  cents == null ? '—' : usd.format(Number(centsToDollars(Number(cents))));

export const qty = (v: number | string | null | undefined): string =>
  v == null || v === '' ? '—' : String(Number(v));

export const monthLabel = (isoDate: string): string => {
  const [y, m] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export const dateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const RATE_UNIT = { salary: '/ year', hourly: '/ hour', daily: '/ day' } as const;

/** Saves a string as a file download in the browser. */
export function downloadFile(filename: string, contentType: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
