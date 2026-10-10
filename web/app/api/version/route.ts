import { versionInfo } from '../../../../src/server/version';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(versionInfo(), { headers: { 'cache-control': 'no-store' } });
}
