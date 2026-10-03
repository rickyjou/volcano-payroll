'use client';
import { useState } from 'react';
import { EXPORT_FIELDS, validateMapping, type ExportField, type MappingColumn, type MappingConfig } from '../../src/lib/exporters';
import { EARNING_CODES, type EarningCode } from '../../src/lib/types';
import { Field } from './ui';

interface Props {
  name: string;
  config: MappingConfig;
  busy: boolean;
  onSave(name: string, config: MappingConfig): void;
  onCancel(): void;
}

/** Column-by-column editor for a custom export mapping, validated with the same rules the exporter uses. */
export function MappingEditor({ name: initialName, config: initial, busy, onSave, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [c, setC] = useState<MappingConfig>(structuredClone(initial));
  const errors = validateMapping(c);

  const setCol = (i: number, patch: Partial<MappingColumn>) =>
    setC({ ...c, columns: c.columns.map((col, j) => (j === i ? { ...col, ...patch } : col)) });
  const move = (i: number, d: -1 | 1) => {
    const cols = [...c.columns];
    [cols[i], cols[i + d]] = [cols[i + d], cols[i]];
    setC({ ...c, columns: cols });
  };

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Format">
          <select value={c.format} onChange={(e) => setC({ ...c, format: e.target.value as MappingConfig['format'] })}>
            <option value="csv">CSV</option><option value="json">JSON</option>
          </select>
        </Field>
        <Field label="Rows">
          <select value={c.row_mode} onChange={(e) => setC({ ...c, row_mode: e.target.value as MappingConfig['row_mode'] })}>
            <option value="per_line">One per employee and earning code</option>
            <option value="per_employee">One per employee (codes as columns)</option>
          </select>
        </Field>
        <Field label="Dates">
          <select value={c.date_format} onChange={(e) => setC({ ...c, date_format: e.target.value as MappingConfig['date_format'] })}>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option><option value="MM/DD/YYYY">MM/DD/YYYY</option>
          </select>
        </Field>
      </div>

      <fieldset>
        <legend>Earning code names in the provider</legend>
        <div className="form-grid">
          {EARNING_CODES.map((code) => (
            <Field key={code} label={code}>
              <input value={c.code_map[code] ?? ''} placeholder={code} onChange={(e) => {
                const code_map = { ...c.code_map };
                if (e.target.value) code_map[code] = e.target.value; else delete code_map[code];
                setC({ ...c, code_map });
              }} />
            </Field>
          ))}
        </div>
      </fieldset>

      {c.format === 'csv' && (
        <fieldset>
          <legend>Columns</legend>
          <table>
            <thead><tr><th scope="col">Header</th><th scope="col">Value</th><th scope="col">Earning code</th><th scope="col" /></tr></thead>
            <tbody>
              {c.columns.map((col, i) => (
                <tr key={i}>
                  <td><input aria-label={`Column ${i + 1} header`} value={col.header} onChange={(e) => setCol(i, { header: e.target.value })} /></td>
                  <td>
                    <select aria-label={`Column ${i + 1} value`} value={col.const != null ? '__const' : col.field}
                      onChange={(e) => setCol(i, e.target.value === '__const' ? { field: undefined, const: '' } : { field: e.target.value as ExportField, const: undefined })}>
                      {EXPORT_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                      <option value="__const">fixed text…</option>
                    </select>
                    {col.const != null && <input aria-label={`Column ${i + 1} fixed text`} value={col.const} onChange={(e) => setCol(i, { const: e.target.value })} />}
                  </td>
                  <td>
                    {c.row_mode === 'per_employee' && col.const == null && (
                      <select aria-label={`Column ${i + 1} earning code`} value={col.code ?? ''} onChange={(e) => setCol(i, { code: (e.target.value || undefined) as EarningCode | undefined })}>
                        <option value="">all</option>
                        {EARNING_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="row-actions">
                    <button type="button" className="secondary small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button type="button" className="secondary small" disabled={i === c.columns.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button type="button" className="secondary small" onClick={() => setC({ ...c, columns: c.columns.filter((_, j) => j !== i) })} aria-label="Remove column">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="secondary small" onClick={() => setC({ ...c, columns: [...c.columns, { header: 'New column', field: 'external_id' }] })}>Add column</button>
        </fieldset>
      )}

      {errors.length > 0 && <ul className="problems" aria-live="polite">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="actions">
        <button type="button" disabled={busy || errors.length > 0 || !name.trim()} onClick={() => onSave(name.trim(), c)}>Save mapping</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
