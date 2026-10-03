import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/lib/signing';
import { dispatchDue } from '../../src/server/webhooks';
import { finalizedRun } from './finalized-run';
import { ok, resetData, seedOrg, service } from './helpers';

const SECRET = `whsec_${'s'.repeat(40)}`;
let server: Server;
let url: string;
let respondWith = 200;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = respondWith;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  await resetData();
  const org = await seedOrg();
  await ok(service().insert('webhook_endpoints', { url, secret: SECRET }));
  await finalizedRun(org);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const deliveries = () => ok<{ status: string; attempts: number; next_attempt_at: string; last_response_code: number | null }>(
  service().from('webhook_deliveries').select('status,attempts,next_attempt_at,last_response_code'));

describe('dispatchDue', () => {
  it('refuses plain http unless allowed', async () => {
    const r = await dispatchDue(service(), { allowHttp: false });
    expect(r).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    expect(received).toHaveLength(0);
  });

  it('retries a failing receiver with backoff', async () => {
    respondWith = 500;
    const later = new Date(Date.now() + 2 * 60_000); // past the 1-minute backoff from the first attempt
    expect(await dispatchDue(service(), { allowHttp: true, now: later })).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    const [d] = await deliveries();
    expect(d).toMatchObject({ status: 'pending', attempts: 2, last_response_code: 500 });
    expect(new Date(d.next_attempt_at).getTime() - later.getTime()).toBe(300_000);
  });

  it('delivers a signed payload the receiver can verify', async () => {
    respondWith = 204;
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await dispatchDue(service(), { allowHttp: true, now: later })).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    const last = received[received.length - 1];
    expect(last.headers['x-payroll-event']).toBe('payroll_run.finalized');
    expect(verifyWebhookSignature(SECRET, last.body, String(last.headers['x-payroll-signature']), Math.floor(later.getTime() / 1000))).toBe(true);
    expect(JSON.parse(last.body)).toMatchObject({ event: 'payroll_run.finalized', data: { period_start: '2026-09-01' } });
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 3 });
  });

  it('does nothing when nothing is due', async () => {
    expect(await dispatchDue(service(), { allowHttp: true })).toEqual({ delivered: 0, retrying: 0, failed: 0 });
  });
});
