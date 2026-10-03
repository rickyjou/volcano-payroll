// Admin-only: create an integration API key. The plaintext key is returned once; only its hash is stored.
import { generateApiKey } from '../lib/signing';
import { requireEmployee } from '../server/auth';
import { rows } from '../server/db';
import { authOf, handle, requireString } from '../server/http';
import { userClient } from '../server/volcano';

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  const me = await requireEmployee(db, auth, ['admin']);
  const name = requireString(event.name, 'name');
  const { key, prefix, hash } = generateApiKey();
  const [row] = await rows<{ id: string }>(db.insert('api_keys', { name, prefix, key_hash: hash, created_by: me.id }));
  return { id: row.id, name, prefix, key };
});
