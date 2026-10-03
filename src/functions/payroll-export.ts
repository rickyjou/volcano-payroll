// Admin-only: render a finalized run with a preset or custom mapping, record it, return the file.
import { render } from '../lib/exporters';
import { sha256Hex } from '../lib/signing';
import { requireEmployee } from '../server/auth';
import { rows } from '../server/db';
import { resolveMapping } from '../server/mappings';
import { HttpError, authOf, handle, requireString } from '../server/http';
import { loadRun, loadRunLines } from '../server/runs';
import { userClient } from '../server/volcano';

export const handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  const me = await requireEmployee(db, auth, ['admin']);
  const runId = requireString(event.run_id, 'run_id');
  const mappingKey = requireString(event.mapping_key, 'mapping_key');

  const { run, exportRun } = await loadRun(db, runId);
  if (run.status !== 'finalized') throw new HttpError(409, 'RUN_NOT_FINALIZED', 'Only finalized runs can be exported');
  const config = await resolveMapping(db, mappingKey);
  let file;
  try {
    file = render(exportRun, await loadRunLines(db, runId), config, mappingKey);
  } catch (e) {
    throw new HttpError(400, 'INVALID_MAPPING', (e as Error).message);
  }
  const sha256 = sha256Hex(file.body);
  const [saved] = await rows<{ id: string }>(db.insert('exports', {
    run_id: runId, mapping_key: mappingKey, filename: file.filename, content_type: file.content_type,
    content: file.body, sha256, created_by: me.id,
  }));
  return { export_id: saved.id, ...file, sha256 };
});
