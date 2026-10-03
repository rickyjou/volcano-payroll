'use client';
// Renders the agent's cards. Every button sends a structured request, never free text.
import { useState } from 'react';
import type { AgentRequest } from '../../../src/agent/agent';
import type { Card, RowAction } from '../../../src/agent/types';
import { downloadFile } from '../../lib/format';

type Send = (req: AgentRequest) => void;

function RowButton({ action, send, busy }: { action: RowAction; send: Send; busy: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  if (!action.needsNote) {
    return <button type="button" className="small" disabled={busy} onClick={() => send({ type: 'tool', ...action.request, label: action.label })}>{action.label}</button>;
  }
  if (note === null) return <button type="button" className="secondary small" disabled={busy} onClick={() => setNote('')}>{action.label}</button>;
  return (
    <form className="chat-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) send({ type: 'tool', tool: action.request.tool, args: { ...action.request.args, note: note.trim() }, label: `${action.label}: ${note.trim()}` }); }}>
      <input aria-label="Reason" placeholder="Reason" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      <button type="submit" className="small" disabled={busy || !note.trim()}>Send</button>
    </form>
  );
}

/** `active` is false for cards in older replies: their questions have moved on. */
export function ChatCard({ card, send, busy, active }: { card: Card; send: Send; busy: boolean; active: boolean }) {
  switch (card.kind) {
    case 'confirm':
      return (
        <div className="chat-card">
          <strong>{card.title}</strong>
          {card.lines.length > 0 && <ul className="plain">{card.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
          <div className="row-actions">
            {card.choices.map((c) => (
              <button key={c.id} type="button" className={`small ${c.style === 'secondary' ? 'secondary' : c.style === 'danger' ? 'danger' : ''}`} disabled={busy || !active}
                onClick={() => send({ type: 'action', actionId: card.actionId, choice: c.id, label: c.label })}>{c.label}</button>
            ))}
          </div>
        </div>
      );
    case 'undo':
      return <button type="button" className="secondary small" disabled={busy} onClick={() => send({ type: 'action', actionId: card.actionId, choice: 'undo', label: 'Undo' })}>{card.label}</button>;
    case 'choices':
      return (
        <div className="chat-card">
          <span>{card.prompt}</span>
          <div className="row-actions">
            {card.options.map((o) => <button key={o.label} type="button" className="secondary small" disabled={busy || !active} onClick={() => send({ type: 'tool', ...o.request, label: o.label })}>{o.label}</button>)}
          </div>
        </div>
      );
    case 'table':
      return (
        <div className="chat-card table-wrap">
          <strong>{card.title}</strong>
          <table>
            <thead><tr>{card.columns.map((c) => <th key={c} scope="col">{c}</th>)}{card.rowActions && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {card.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => <td key={j}>{v}</td>)}
                  {card.rowActions && <td><div className="row-actions">{card.rowActions[i]?.map((a) => <RowButton key={a.label} action={a} send={send} busy={busy} />)}</div></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'download':
      return (
        <div className="chat-card">
          {card.body
            ? <button type="button" className="small" onClick={() => downloadFile(card.filename, card.contentType, card.body)}>Download {card.filename}</button>
            : <span className="muted">{card.filename} — download it again from the payroll run page.</span>}
          {card.warnings.length > 0 && <ul className="problems">{card.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </div>
      );
    case 'secret':
      return (
        <div className="chat-card">
          <strong>{card.label}</strong>
          {card.value
            ? <><code className="secret">{card.value}</code><button type="button" className="secondary small" onClick={() => void navigator.clipboard.writeText(card.value)}>Copy</button></>
            : <span className="muted"> was shown once and isn&apos;t stored.</span>}
        </div>
      );
    case 'link':
      return <a className="button secondary small" href={card.href}>{card.label}</a>;
  }
}
