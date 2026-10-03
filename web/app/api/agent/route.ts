import { agentConfigFromEnv, handleAgentHttp } from '../../../../src/agent/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleAgentHttp(request, agentConfigFromEnv(process.env));
}
