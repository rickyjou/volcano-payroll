// Read-only REST API for payroll providers and connectors, served by the
// Next.js route web/app/api/v1/[...path]/route.ts. Uses the service client;
// every request must carry a valid API key.
import type { VolcanoAuth } from '@volcano.dev/sdk';
import { render } from '../lib/exporters';
import { apiKeyMatches, parseApiKey, sha256Hex } from '../lib/signing';
import { isoDate, rows } from './db';
import { HttpError } from './http';
import { resolveMapping } from './mappings';
import { loadRun, loadRunLines, type RunRow } from './runs';

export interface ApiResponse { status: number; headers: Record<string, string>; body: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown): ApiResponse => ({ status, headers: JSON_HEADERS, body: JSON.stringify(body) });

async function authenticate(db: VolcanoAuth, authorization: string | null): Promise<string> {
  const key = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const parsed = parseApiKey(key);
  const fail = new HttpError(401, 'UNAUTHENTICATED', 'Send a valid API key as "Authorization: Bearer pk_..."');
  if (!parsed) throw fail;
  const [row] = await rows<{ id: string; key_hash: string; revoked_at: string | null }>(
    db.from('api_keys').select('id,key_hash,revoked_at').eq('prefix', parsed.prefix).limit(1));
  if (!row || row.revoked_at || !apiKeyMatches(key, row.key_hash)) throw fail;
  await db.update('api_keys', { last_used_at: new Date().toISOString() }).eq('id', row.id);
  return row.id;
}

function runView(run: RunRow, period: { start_date: string; end_date: string }) {
  return {
    id: run.id, status: run.status, period_start: isoDate(period.start_date), period_end: isoDate(period.end_date),
    finalized_at: run.finalized_at, voided_at: run.voided_at, totals: run.totals,
  };
}

async function visibleRun(db: VolcanoAuth, id: string) {
  if (!UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', 'Payroll run not found');
  const loaded = await loadRun(db, id);
  if (loaded.run.status === 'draft') throw new HttpError(404, 'NOT_FOUND', 'Payroll run not found');
  return loaded;
}

async function route(db: VolcanoAuth, path: string[], query: URLSearchParams, apiKeyId: string): Promise<ApiResponse> {
  if (path.length === 1 && path[0] === 'runs') {
    const status = query.get('status') ?? 'finalized';
    if (!['finalized', 'voided'].includes(status)) throw new HttpError(400, 'BAD_REQUEST', 'status must be finalized or voided');
    const runs = await rows<RunRow>(db.from('payroll_runs').select('id,pay_period_id,status,totals,warnings,finalized_at,voided_at')
      .eq('status', status).order('finalized_at', { ascending: false }).limit(100));
    const periods = runs.length
      ? new Map((await rows<{ id: string; start_date: string; end_date: string }>(db.from('pay_periods').select('id,start_date,end_date')
        .in('id', [...new Set(runs.map((r) => r.pay_period_id))]))).map((p) => [p.id, p]))
      : new Map();
    return json(200, { data: runs.map((r) => runView(r, periods.get(r.pay_period_id)!)) });
  }
  if (path[0] !== 'runs' || path.length < 2 || path.length > 3) throw new HttpError(404, 'NOT_FOUND', 'Unknown endpoint');

  const { run, exportRun } = await visibleRun(db, path[1]);
  if (path.length === 2) {
    return json(200, { data: runView(run, { start_date: exportRun.period_start, end_date: exportRun.period_end }) });
  }
  if (path[2] === 'lines') return json(200, { data: await loadRunLines(db, run.id) });
  if (path[2] === 'export') {
    if (run.status !== 'finalized') throw new HttpError(409, 'RUN_NOT_FINALIZED', 'Only finalized runs can be exported');
    const mappingKey = query.get('mapping') ?? 'generic_csv';
    const config = await resolveMapping(db, mappingKey);
    let file;
    try {
      file = render(exportRun, await loadRunLines(db, run.id), config, mappingKey);
    } catch (e) {
      throw new HttpError(400, 'INVALID_MAPPING', (e as Error).message);
    }
    const sha256 = sha256Hex(file.body);
    await rows(db.insert('exports', {
      run_id: run.id, mapping_key: mappingKey, filename: file.filename, content_type: file.content_type,
      content: file.body, sha256, api_key_id: apiKeyId,
    }));
    return {
      status: 200,
      headers: {
        'Content-Type': file.content_type,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Content-SHA256': sha256,
        'Cache-Control': 'no-store',
      },
      body: file.body,
    };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Unknown endpoint');
}

export async function handleIntegrationRequest(
  db: VolcanoAuth, method: string, path: string[], query: URLSearchParams, authorization: string | null,
): Promise<ApiResponse> {
  try {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This API is read-only');
    const apiKeyId = await authenticate(db, authorization);
    return await route(db, path, query, apiKeyId);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code });
    console.error('integration api error', e);
    return json(500, { error: 'Internal error', code: 'INTERNAL' });
  }
}
