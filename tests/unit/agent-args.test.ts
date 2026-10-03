import { describe, expect, it } from 'vitest';
import { missingArgs, toJsonSchema, validateArgs } from '../../src/agent/args';
import type { ArgDef } from '../../src/agent/types';

const defs: Record<string, ArgDef> = {
  day: { type: 'date', required: true, description: 'Day worked' },
  hours: { type: 'number', description: 'Hours' },
  code: { type: { enum: ['REG', 'PTO'] }, description: 'Earning code' },
  ids: { type: 'uuids', description: 'Timesheets' },
};
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('validateArgs', () => {
  it('keeps valid values, normalises them and drops unknown keys', () => {
    expect(validateArgs(defs, { day: '2026-10-07', hours: '7.5', code: 'PTO', ids: [ID.toUpperCase(), ID], extra: 1 }))
      .toEqual({ ok: true, args: { day: '2026-10-07', hours: 7.5, code: 'PTO', ids: [ID] } });
  });
  it('reports every problem at once', () => {
    expect(validateArgs(defs, { hours: 'lots', code: 'OT', ids: [] }))
      .toEqual({ ok: false, error: 'day is required; hours must be number; code must be one of REG, PTO; ids must be uuids' });
  });
  it('rejects impossible dates', () => {
    expect(validateArgs(defs, { day: '2026-02-30' })).toEqual({ ok: false, error: 'day must be date' });
  });
  it('lists missing required arguments', () => {
    expect(missingArgs(defs, { hours: 8 })).toEqual(['day']);
  });
});

describe('toJsonSchema', () => {
  it('describes arguments for an LLM tool definition', () => {
    expect(toJsonSchema(defs)).toEqual({
      type: 'object',
      properties: {
        day: { type: 'string', format: 'date', description: 'YYYY-MM-DD — Day worked' },
        hours: { type: 'number', description: 'Hours' },
        code: { type: 'string', enum: ['REG', 'PTO'], description: 'Earning code' },
        ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, description: 'Timesheets' },
      },
      required: ['day'],
      additionalProperties: false,
    });
  });
});
