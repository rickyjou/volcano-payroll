// Delivers due webhooks. Runs on a schedule (SUPERAGENT plan) and on demand
// from the admin Integrations page. Delivery state is only reachable with the
// service key, so callers are checked first.
import { requireEmployee } from '../server/auth';
import { one, rows } from '../server/db';
import { authOf, handle } from '../server/http';
import { serviceClient, userClient } from '../server/volcano';
import { dispatchDue } from '../server/webhooks';

export const handler = handle(async (event) => {
  // Scheduled runs carry __volcano_schedule and no user. A forged marker is
  // harmless: dispatch only sends deliveries that are already due.
  if (!event.__volcano_schedule) {
    const auth = authOf(event);
    await requireEmployee(userClient(auth.access_token), auth, ['admin']);
  }
  const db = serviceClient();
  if (typeof event.test_endpoint_id === 'string') {
    const ep = await one<{ id: string }>(db.from('webhook_endpoints').select('id').eq('id', event.test_endpoint_id), 'Webhook endpoint not found');
    await rows(db.insert('webhook_deliveries', {
      endpoint_id: ep.id,
      event: 'ping',
      payload: JSON.stringify({ id: globalThis.crypto.randomUUID(), event: 'ping', created_at: new Date().toISOString(), data: {} }),
    }));
  }
  return dispatchDue(db);
});
