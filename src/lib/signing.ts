// Server-only (node:crypto). Webhook signatures and API key hashing.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const hmacHex = (secret: string, msg: string): string => createHmac('sha256', secret).update(msg, 'utf8').digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** `X-Payroll-Signature` value: t=<unix seconds>,v1=<hex hmac_sha256(secret, "<t>.<body>")> */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacHex(secret, `${unixSeconds}.${body}`)}`;
}

/** Receiver-side check, also used by tests. Rejects signatures older than `toleranceSec`. */
export function verifyWebhookSignature(secret: string, body: string, header: string, nowSec: number, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqualHex(parts.v1, hmacHex(secret, `${t}.${body}`));
}

const API_KEY_RE = /^pk_([0-9a-f]{8})_([A-Za-z0-9_-]{32})$/;

/** Returns the plaintext key (show once), its lookup prefix, and the hash to store. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const key = `pk_${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, prefix, hash: sha256Hex(key) };
}

export function parseApiKey(key: string): { prefix: string } | null {
  const m = API_KEY_RE.exec(key);
  return m ? { prefix: m[1] } : null;
}

export const apiKeyMatches = (key: string, storedHash: string): boolean => safeEqualHex(sha256Hex(key), storedHash);

/** Delay before the next try, indexed by attempts already made (1-based). */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_SECONDS.length + 1;

/** After `attemptsMade` failed tries, when to retry — or null to give up. */
export function nextAttemptAt(attemptsMade: number, now: Date): Date | null {
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + WEBHOOK_BACKOFF_SECONDS[attemptsMade - 1] * 1000);
}
