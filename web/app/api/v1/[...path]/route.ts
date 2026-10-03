import { handleIntegrationRequest } from '../../../../../src/server/integration-api';
import { serviceClient } from '../../../../../src/server/volcano';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = new URL(request.url);
  const res = await handleIntegrationRequest(serviceClient(), 'GET', path, url.searchParams, request.headers.get('authorization'));
  return new Response(res.body, { status: res.status, headers: res.headers });
}
