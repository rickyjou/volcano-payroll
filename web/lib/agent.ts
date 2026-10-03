'use client';
// Browser client for /api/agent. Sends the user's own access token; the server acts as them.
import type { AgentRequest, AgentResponse } from '../../src/agent/agent';
import { ApiError } from './api';
import { getVolcano } from './volcano';

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function callAgent(req: AgentRequest): Promise<AgentResponse> {
  const { data } = await getVolcano().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('Your session has expired. Sign in again.', 'UNAUTHENTICATED');
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    // The server uses the browser's date for "today" (within a day of its own clock).
    body: JSON.stringify({ ...req, today: localDate() }),
  });
  const body = (await res.json().catch(() => null)) as (AgentResponse & { error?: string; code?: string }) | null;
  if (!res.ok || !body) throw new ApiError(body?.error ?? `The assistant failed (HTTP ${res.status})`, body?.code ?? 'AGENT_ERROR');
  return body;
}
