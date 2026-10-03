'use client';
// Docked chat with the payroll assistant. Opens from the header on every page; a
// full-screen sheet on phones. Replies can change data, so pages are told to reload.
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentRequest } from '../../src/agent/agent';
import type { ChatMessage } from '../../src/agent/types';
import { callAgent } from '../lib/agent';
import { errorMessage } from '../lib/api';
import { emitDataChanged } from '../lib/events';
import type { Role } from '../../src/lib/employee-import';
import { ChatCard } from './chat/ChatCards';
import { ErrorBanner, Loading } from './ui';

const SUGGESTIONS: Record<Role, string[]> = {
  employee: ['Log 8 hours for today', 'Show my timesheet', 'Submit my timesheet'],
  manager: ['What needs my approval?', "Who on my team hasn't submitted?", 'Log 8 hours for today'],
  admin: ['What needs my approval?', 'Lock this month', "Generate this month's run"],
};

export function ChatPanel({ role, onClose }: { role: Role; onClose: () => void }) {
  const pathname = usePathname();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    callAgent({ type: 'history' }).then((r) => setMessages(r.messages)).catch((e) => { setMessages([]); setError(errorMessage(e)); });
    inputRef.current?.focus();
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, busy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send(req: AgentRequest) {
    setBusy(true);
    setError(null);
    try {
      const r = await callAgent(req);
      setMessages((m) => [...(m ?? []), ...r.messages]);
      emitDataChanged(r.changed);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    void send({ type: 'message', text: t, page: pathname });
  }

  return (
    <aside className="chat-panel" aria-label="Payroll assistant">
      <div className="chat-head">
        <strong>Assistant</strong>
        <button type="button" className="secondary small" onClick={onClose}>Close</button>
      </div>
      <div className="chat-log" aria-live="polite">
        {messages === null ? <Loading label="Loading conversation…" /> : messages.length === 0 ? (
          <div className="chat-empty">
            <p className="muted">Ask me to log time, approve timesheets or run payroll. Try:</p>
            <div className="row-actions">
              {SUGGESTIONS[role].map((s) => <button key={s} type="button" className="secondary small" disabled={busy} onClick={() => void send({ type: 'message', text: s, page: pathname })}>{s}</button>)}
            </div>
          </div>
        ) : messages.map((m, idx) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.content && <p>{m.content}</p>}
            {m.cards.map((c, i) => <ChatCard key={i} card={c} send={(r) => void send(r)} busy={busy} active={idx === messages.length - 1} />)}
          </div>
        ))}
        {busy && <Loading label="Thinking…" />}
        <div ref={endRef} />
      </div>
      <ErrorBanner error={error} />
      <form className="chat-input" onSubmit={submit}>
        <input ref={inputRef} aria-label="Message the assistant" placeholder="e.g. log 8 hours for today" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
