// Money is integer cents; hours are integer hundredths; days are integer tenths.

/** n / d rounded half-up, exact for safe integers. */
export function divRoundHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) {
    throw new Error(`divRoundHalfUp needs safe integers and d > 0 (got ${n}/${d})`);
  }
  if (n < 0) return -divRoundHalfUp(-n, d);
  let q = Math.floor(n / d);
  let r = n - q * d;
  while (r < 0) { q -= 1; r += d; }
  while (r >= d) { q += 1; r -= d; }
  return 2 * r >= d ? q + 1 : q;
}

export const toHundredths = (x: number): number => Math.round(x * 100);
export const toTenths = (x: number): number => Math.round(x * 10);
export const toThousandths = (x: number): number => Math.round(x * 1000);

export function centsToDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** '12.5' / '1,234.56' / '$40' → cents; throws on anything else. */
export function dollarsToCents(input: string): number {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${input}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
