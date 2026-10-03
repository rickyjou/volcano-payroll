import { beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/lib/signing';
import { handleIntegrationRequest } from '../../src/server/integration-api';
import { finalizedRun } from './finalized-run';
import { ok, resetData, seedOrg, service } from './helpers';

let key: string;
let runId: string;

const call = (path: string[], query = '', auth: string | null = `Bearer ${key}`, method = 'GET') =>
  handleIntegrationRequest(service(), method, path, new URLSearchParams(query), auth);

beforeAll(async () => {
  await resetData();
  const org = await seedOrg();
  ({ runId } = await finalizedRun(org));
  const k = generateApiKey();
  key = k.key;
  await ok(service().insert('api_keys', { name: 'test', prefix: k.prefix, key_hash: k.hash }));
});

describe('integration API', () => {
  it('requires a valid key', async () => {
    expect((await call(['runs'], '', null)).status).toBe(401);
    expect((await call(['runs'], '', 'Bearer pk_00000000_' + 'a'.repeat(32))).status).toBe(401);
    expect((await call(['runs'], '', `Bearer ${key.slice(0, -1)}x`)).status).toBe(401);
  });

  it('is read-only', async () => {
    expect((await call(['runs'], '', `Bearer ${key}`, 'POST')).status).toBe(405);
  });

  it('lists finalized runs', async () => {
    const r = await call(['runs']);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).data).toEqual([expect.objectContaining({ id: runId, status: 'finalized', period_start: '2026-09-01', period_end: '2026-09-30' })]);
  });

  it('returns canonical lines', async () => {
    const r = await call(['runs', runId, 'lines']);
    expect(JSON.parse(r.body).data).toEqual([expect.objectContaining({ external_id: 'E-ALICE', earning_code: 'REG', hours: 40, amount_cents: 100_000 })]);
  });

  it('exports a preset and records the export', async () => {
    const r = await call(['runs', runId, 'export'], 'mapping=gusto');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="payroll-2026-09-gusto.csv"');
    expect(r.body.split('\r\n')[1]).toBe(`Test,Alice,${(await ok<{ email: string }>(service().from('employees').select('email').eq('external_id', 'E-ALICE')))[0].email},40.00,,,,,`);
    expect(await ok(service().from('exports').select('id'))).toHaveLength(1);
  });

  it('404s unknown runs, mappings and paths', async () => {
    expect((await call(['runs', 'not-a-uuid'])).status).toBe(404);
    expect((await call(['runs', '00000000-0000-4000-8000-000000000000'])).status).toBe(404);
    expect((await call(['runs', runId, 'export'], 'mapping=nope')).status).toBe(404);
    expect((await call(['employees'])).status).toBe(404);
  });

  it('rejects revoked keys', async () => {
    await ok(service().update('api_keys', { revoked_at: new Date().toISOString() }).neq('id', '00000000-0000-0000-0000-000000000000'));
    expect((await call(['runs'])).status).toBe(401);
  });
});
