import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newWebhookSecret, randomToken } from '../../src/lib/random';
import {
  apiKeyMatches, generateApiKey, nextAttemptAt, parseApiKey, sha256Hex, signWebhook, verifyWebhookSignature,
} from '../../src/lib/signing';

describe('webhook signatures', () => {
  it('matches an independently computed HMAC', () => {
    const expected = createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex');
    expect(signWebhook('whsec_test', '{"a":1}', 1_700_000_000)).toBe(`t=1700000000,v1=${expected}`);
  });
  it('verifies, and rejects tampering, wrong secrets and stale timestamps', () => {
    const header = signWebhook('s', 'body', 1000);
    expect(verifyWebhookSignature('s', 'body', header, 1100)).toBe(true);
    expect(verifyWebhookSignature('s', 'body2', header, 1100)).toBe(false);
    expect(verifyWebhookSignature('other', 'body', header, 1100)).toBe(false);
    expect(verifyWebhookSignature('s', 'body', header, 1000 + 301)).toBe(false);
    expect(verifyWebhookSignature('s', 'body', 'garbage', 1000)).toBe(false);
  });
});

describe('api keys', () => {
  it('generates parseable keys whose hash matches', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^pk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/);
    expect(parseApiKey(key)).toEqual({ prefix });
    expect(hash).toBe(sha256Hex(key));
    expect(apiKeyMatches(key, hash)).toBe(true);
    const tampered = `${key.slice(0, -1)}${key.endsWith('x') ? 'y' : 'x'}`;
    expect(apiKeyMatches(tampered, hash)).toBe(false);
  });
  it('rejects malformed keys', () => {
    expect(parseApiKey('pk_123_abc')).toBeNull();
    expect(parseApiKey('Bearer pk_...')).toBeNull();
  });
});

describe('retry schedule', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  it('backs off 1m, 5m, 30m, 2h, 12h then gives up after 6 attempts', () => {
    expect([1, 2, 3, 4, 5].map((n) => (nextAttemptAt(n, now)!.getTime() - now.getTime()) / 1000)).toEqual([60, 300, 1800, 7200, 43200]);
    expect(nextAttemptAt(6, now)).toBeNull();
  });
});

describe('randomToken', () => {
  it('is url-safe and unique', () => {
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(newWebhookSecret()).toMatch(/^whsec_/);
  });
});
