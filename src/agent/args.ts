// Validates tool arguments on every path (decider, LLM, card buttons) and describes them
// to the LLM as JSON Schema. Unknown keys are dropped; values are normalised.
import { toUtc } from '../lib/dates';
import type { ArgDef, ArgType } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function check(type: ArgType, v: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof type === 'object') {
    return typeof v === 'string' && type.enum.includes(v) ? { ok: true, value: v } : { ok: false };
  }
  switch (type) {
    case 'string':
      return typeof v === 'string' && v.trim() !== '' ? { ok: true, value: v.trim() } : { ok: false };
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false };
    case 'date':
      try {
        return typeof v === 'string' ? (toUtc(v), { ok: true, value: v }) : { ok: false };
      } catch {
        return { ok: false };
      }
    case 'month':
      return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? { ok: true, value: v } : { ok: false };
    case 'uuid':
      return typeof v === 'string' && UUID_RE.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false };
    case 'uuids':
      return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && UUID_RE.test(x))
        ? { ok: true, value: [...new Set(v.map((x: string) => x.toLowerCase()))] }
        : { ok: false };
  }
}

const typeLabel = (t: ArgType): string => (typeof t === 'object' ? `one of ${t.enum.join(', ')}` : t);

export function validateArgs(defs: Record<string, ArgDef>, raw: Record<string, unknown> | null | undefined): ArgsResult {
  const args: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    const v = raw?.[name];
    if (v === undefined || v === null || v === '') {
      if (def.required) problems.push(`${name} is required`);
      continue;
    }
    const r = check(def.type, v);
    if (r.ok) args[name] = r.value;
    else problems.push(`${name} must be ${typeLabel(def.type)}`);
  }
  return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true, args };
}

export const missingArgs = (defs: Record<string, ArgDef>, args: Record<string, unknown>): string[] =>
  Object.entries(defs).filter(([n, d]) => d.required && (args[n] === undefined || args[n] === null)).map(([n]) => n);

function schemaOf(t: ArgType): Record<string, unknown> {
  if (typeof t === 'object') return { type: 'string', enum: [...t.enum] };
  switch (t) {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'date': return { type: 'string', format: 'date', description: 'YYYY-MM-DD' };
    case 'month': return { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'YYYY-MM' };
    case 'uuid': return { type: 'string', format: 'uuid' };
    case 'uuids': return { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 };
    default: return { type: 'string' };
  }
}

/** JSON Schema for an LLM tool definition. */
export function toJsonSchema(defs: Record<string, ArgDef>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(defs)) {
    const s = schemaOf(def.type);
    properties[name] = { ...s, description: [s.description, def.description].filter(Boolean).join(' — ') };
  }
  return {
    type: 'object',
    properties,
    required: Object.entries(defs).filter(([, d]) => d.required).map(([n]) => n),
    additionalProperties: false,
  };
}
