'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PRESETS, type MappingConfig } from '../../../../src/lib/exporters';
import { newWebhookSecret } from '../../../../src/lib/random';
import { AppShell } from '../../../components/AppShell';
import { MappingEditor } from '../../../components/MappingEditor';
import { Badge, Empty, ErrorBanner, Field, Loading, Notice } from '../../../components/ui';
import { errorMessage, invoke, q, write } from '../../../lib/api';
import { dateTime } from '../../../lib/format';
import { getVolcano } from '../../../lib/volcano';
import { useDataChanged } from '../../../lib/events';

interface Mapping { id: string; name: string; based_on: string | null; config: MappingConfig; updated_at: string }
interface ApiKey { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface Endpoint { id: string; url: string; description: string | null; secret: string; events: string[]; active: boolean }
interface Delivery { id: string; endpoint_id: string; event: string; status: string; attempts: number; next_attempt_at: string; last_response_code: number | null; last_error: string | null; created_at: string }

const EVENTS = ['payroll_run.finalized', 'payroll_run.voided'];

function Integrations() {
  const [data, setData] = useState<{ mappings: Mapping[]; keys: ApiKey[]; endpoints: Endpoint[]; deliveries: Delivery[] } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string; based_on: string | null; config: MappingConfig } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [hook, setHook] = useState({ url: '', description: '', events: EVENTS });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const db = getVolcano();
      const [mappings, keys, endpoints, deliveries] = await Promise.all([
        q<Mapping>(db.from('export_mappings').select('id,name,based_on,config,updated_at').order('name')),
        q<ApiKey>(db.from('api_keys').select('id,name,prefix,created_at,last_used_at,revoked_at').order('created_at', { ascending: false })),
        q<Endpoint>(db.from('webhook_endpoints').select('id,url,description,secret,events,active').order('created_at')),
        q<Delivery>(db.from('webhook_deliveries').select('id,endpoint_id,event,status,attempts,next_attempt_at,last_response_code,last_error,created_at').order('created_at', { ascending: false }).limit(50)),
      ]);
      setData({ mappings, keys, endpoints, deliveries });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useDataChanged(load);

  async function run(fn: () => Promise<unknown>, done: string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); if (done) setNotice(done); await load(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  function saveMapping(name: string, config: MappingConfig) {
    const db = getVolcano();
    const values = { name, based_on: editing!.based_on, config: JSON.stringify(config) };
    void run(async () => {
      if (editing!.id) await write(db.update('export_mappings', values).eq('id', editing!.id), 'the mapping');
      else await q(db.insert('export_mappings', values));
      setEditing(null);
    }, 'Mapping saved. Use it from a finalized run’s Export section.');
  }

  function createKey(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const r = await invoke<{ key: string }>('api-key-create', { name: keyName.trim() });
      setNewKey(r.key);
      setKeyName('');
    }, null);
  }

  function addHook(e: FormEvent) {
    e.preventDefault();
    const secret = newWebhookSecret();
    void run(async () => {
      await q(getVolcano().insert('webhook_endpoints', {
        url: hook.url.trim(), description: hook.description.trim() || null, secret, events: JSON.stringify(hook.events),
      }));
      setHook({ url: '', description: '', events: EVENTS });
    }, `Webhook added. Its signing secret is ${secret} — give it to the receiver so it can verify X-Payroll-Signature.`);
  }

  if (!data) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <Loading />;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}

      <section className="panel">
        <h2>Export formats</h2>
        <p className="muted">Built-in formats are starting points for common payroll providers. Copy one to adjust columns or earning code names for your account.</p>
        <ul className="cards">
          {PRESETS.map((p) => (
            <li key={p.key} className="card">
              <div className="card-head"><strong>{p.name}</strong>
                <button type="button" className="secondary small" onClick={() => setEditing({ id: null, name: `${p.name} (custom)`, based_on: p.key, config: p.config })}>Copy and edit</button>
              </div>
              <p className="muted">{p.note}</p>
            </li>
          ))}
          {data.mappings.map((m) => (
            <li key={m.id} className="card">
              <div className="card-head"><strong>{m.name}</strong> <span className="muted">custom{m.based_on ? `, from ${m.based_on}` : ''}</span>
                <button type="button" className="secondary small" onClick={() => setEditing({ id: m.id, name: m.name, based_on: m.based_on, config: m.config })}>Edit</button>
                <button type="button" className="danger small" disabled={busy} onClick={() => {
                  if (window.confirm(`Delete ${m.name}?`)) void run(() => write(getVolcano().delete('export_mappings').eq('id', m.id), 'the mapping'), 'Mapping deleted.');
                }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
        {editing && (
          <div className="panel">
            <h3>{editing.id ? 'Edit mapping' : 'New mapping'}</h3>
            <MappingEditor name={editing.name} config={editing.config} busy={busy} onSave={saveMapping} onCancel={() => setEditing(null)} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2>API keys</h2>
        <p className="muted">Let a payroll provider or connector pull finalized runs. Read-only.</p>
        <pre className="code">{`curl -H "Authorization: Bearer pk_..." ${origin}/api/v1/runs
curl -H "Authorization: Bearer pk_..." ${origin}/api/v1/runs/<run-id>/lines
curl -H "Authorization: Bearer pk_..." "${origin}/api/v1/runs/<run-id>/export?mapping=gusto"`}</pre>
        {newKey && (
          <div className="alert info" role="status">
            <span>Copy this key now — it won’t be shown again: <code>{newKey}</code></span>
            <button type="button" className="secondary small" onClick={() => void navigator.clipboard.writeText(newKey)}>Copy</button>
            <button type="button" className="secondary small" onClick={() => setNewKey(null)}>Done</button>
          </div>
        )}
        <form className="toolbar" onSubmit={createKey}>
          <Field label="Key name"><input required value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Gusto connector" /></Field>
          <button type="submit" disabled={busy}>Create key</button>
        </form>
        {data.keys.length === 0 ? <Empty>No API keys.</Empty> : (
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col" /></tr></thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td><td><code>pk_{k.prefix}_…</code></td><td>{dateTime(k.created_at)}</td><td>{dateTime(k.last_used_at)}</td>
                  <td>{k.revoked_at ? <Badge value="revoked" /> : (
                    <button type="button" className="danger small" disabled={busy} onClick={() => {
                      if (window.confirm(`Revoke ${k.name}? Anything using it stops working.`)) {
                        void run(() => write(getVolcano().update('api_keys', { revoked_at: new Date().toISOString() }).eq('id', k.id), 'the key'), 'Key revoked.');
                      }
                    }}>Revoke</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Webhooks</h2>
        <p className="muted">We POST JSON when a run is finalized or voided, signed with <code>X-Payroll-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256 of “t.body”&gt;</code>. Failed deliveries retry after 1 m, 5 m, 30 m, 2 h and 12 h.</p>
        <form className="form-grid" onSubmit={addHook}>
          <Field label="URL" hint="Must use https"><input type="url" required value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} /></Field>
          <Field label="Description"><input value={hook.description} onChange={(e) => setHook({ ...hook, description: e.target.value })} /></Field>
          <fieldset>
            <legend>Events</legend>
            {EVENTS.map((ev) => (
              <label key={ev} className="inline">
                <input type="checkbox" checked={hook.events.includes(ev)} onChange={(e) => setHook({ ...hook, events: e.target.checked ? [...hook.events, ev] : hook.events.filter((x) => x !== ev) })} /> {ev}
              </label>
            ))}
          </fieldset>
          <div className="form-actions"><button type="submit" disabled={busy || hook.events.length === 0}>Add webhook</button></div>
        </form>
        {data.endpoints.length > 0 && (
          <table>
            <thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Status</th><th scope="col" /></tr></thead>
            <tbody>
              {data.endpoints.map((ep) => (
                <tr key={ep.id}>
                  <td>{ep.url}{ep.description && <div className="muted">{ep.description}</div>}</td>
                  <td>{ep.events.join(', ')}</td>
                  <td><Badge value={ep.active ? 'active' : 'paused'} /></td>
                  <td className="row-actions">
                    <button type="button" className="secondary small" disabled={busy} onClick={() => void run(() => invoke('webhook-dispatch', { test_endpoint_id: ep.id }), 'Test event sent — see deliveries below.')}>Send test</button>
                    <button type="button" className="secondary small" onClick={() => setRevealed(revealed === ep.id ? null : ep.id)}>{revealed === ep.id ? 'Hide secret' : 'Show secret'}</button>
                    <button type="button" className="secondary small" disabled={busy} onClick={() => void run(() => write(getVolcano().update('webhook_endpoints', { active: !ep.active }).eq('id', ep.id), 'the webhook'), null)}>{ep.active ? 'Pause' : 'Resume'}</button>
                    <button type="button" className="danger small" disabled={busy} onClick={() => {
                      if (window.confirm('Delete this webhook and its delivery history?')) void run(() => write(getVolcano().delete('webhook_endpoints').eq('id', ep.id), 'the webhook'), 'Webhook deleted.');
                    }}>Delete</button>
                    {revealed === ep.id && <code className="secret">{ep.secret}</code>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>Recent deliveries</h3>
        <button type="button" className="secondary small" disabled={busy} onClick={() => void run(async () => {
          const r = await invoke<{ delivered: number; retrying: number; failed: number }>('webhook-dispatch');
          setNotice(`${r.delivered} delivered, ${r.retrying} will retry, ${r.failed} failed.`);
        }, null)}>Send due deliveries now</button>
        {data.deliveries.length === 0 ? <Empty>No deliveries yet.</Empty> : (
          <table>
            <thead><tr><th scope="col">Event</th><th scope="col">Endpoint</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last result</th><th scope="col">Next try</th><th scope="col" /></tr></thead>
            <tbody>
              {data.deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{d.event}</td>
                  <td>{data.endpoints.find((e) => e.id === d.endpoint_id)?.url ?? '—'}</td>
                  <td><Badge value={d.status} /></td>
                  <td>{d.attempts}</td>
                  <td>{d.last_response_code ?? ''} {d.last_error ?? ''}</td>
                  <td>{d.status === 'pending' ? dateTime(d.next_attempt_at) : '—'}</td>
                  <td>{d.status === 'failed' && (
                    <button type="button" className="secondary small" disabled={busy} onClick={() => void run(
                      () => write(getVolcano().update('webhook_deliveries', { status: 'pending', next_attempt_at: new Date().toISOString() }).eq('id', d.id), 'the delivery'),
                      'Queued for retry. Use “Send due deliveries now” to send it immediately.',
                    )}>Retry</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

export default function IntegrationsPage() {
  return (
    <AppShell roles={['admin']}>
      <h1>Integrations</h1>
      <Integrations />
    </AppShell>
  );
}
