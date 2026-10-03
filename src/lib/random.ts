// Works in browsers and Node 22+ (both expose Web Crypto as globalThis.crypto).
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const newWebhookSecret = (): string => `whsec_${randomToken(32)}`;
