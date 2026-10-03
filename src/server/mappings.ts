import type { VolcanoAuth } from '@volcano.dev/sdk';
import { findPreset, type MappingConfig } from '../lib/exporters';
import { one } from './db';
import { HttpError } from './http';

/** Preset keys ("gusto") are used as-is; custom mappings are addressed as "custom:<uuid>". */
export async function resolveMapping(db: VolcanoAuth, key: string): Promise<MappingConfig> {
  if (key.startsWith('custom:')) {
    const id = key.slice(7);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'NOT_FOUND', `Unknown export mapping "${key}"`);
    const m = await one<{ config: MappingConfig }>(db.from('export_mappings').select('config').eq('id', id), 'Export mapping not found');
    return m.config;
  }
  const preset = findPreset(key);
  if (!preset) throw new HttpError(404, 'NOT_FOUND', `Unknown export mapping "${key}"`);
  return preset.config;
}
