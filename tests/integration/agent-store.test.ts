// Chat history and agent actions are private to each user, and an action moves state once.
import { beforeAll, describe, expect, it } from 'vitest';
import { createAction, getAction, history, latestPending, moveAction, saveMessage } from '../../src/agent/store';
import { newUser, ok, resetData, type TestUser } from './helpers';

const NOW = new Date('2026-10-07T15:00:00Z');
let a: TestUser;
let b: TestUser;

beforeAll(async () => {
  await resetData();
  [a, b] = [await newUser('chat-a'), await newUser('chat-b')];
});

describe('chat store', () => {
  it("saves messages and keeps one-time values out of what is stored", async () => {
    const shown = await saveMessage(a.client, a.userId, 'assistant', 'Here is your key', [
      { kind: 'secret', label: 'API key', value: 'pk_secret' },
      { kind: 'download', filename: 'f.csv', contentType: 'text/csv', body: 'a,b', warnings: [] },
    ]);
    expect(shown.cards[0]).toMatchObject({ value: 'pk_secret' });
    const [stored] = await ok<{ cards: { value?: string; body?: string }[] }>(a.client.from('chat_messages').select('cards').eq('id', shown.id));
    expect(stored.cards).toEqual([
      { kind: 'secret', label: 'API key', value: '' },
      { kind: 'download', filename: 'f.csv', contentType: 'text/csv', body: '', warnings: [] },
    ]);
  });

  it('returns history oldest first and drops messages older than 30 days', async () => {
    await saveMessage(a.client, a.userId, 'user', 'hello');
    await ok(a.client.insert('chat_messages', { user_id: a.userId, role: 'user', content: 'ancient', created_at: '2026-08-01T00:00:00Z' }));
    const h = await history(a.client, a.userId, NOW);
    expect(h.map((m) => m.content)).toEqual(['Here is your key', 'hello']);
    expect(await ok(a.client.from('chat_messages').select('id').eq('content', 'ancient'))).toEqual([]);
  });

  it("hides one user's messages and actions from another", async () => {
    const act = await createAction(a.client, a.userId, { tool: 'log_time', args: { day: '2026-10-07' }, status: 'pending', expiresAt: new Date(NOW.getTime() + 600_000) });
    expect(await ok(b.client.from('chat_messages').select('id'))).toEqual([]);
    expect(await getAction(b.client, b.userId, act.id)).toBeNull();
    expect(await getAction(b.client, a.userId, act.id)).toBeNull();
    expect(await moveAction(b.client, a.userId, act.id, 'pending', 'done')).toBe(false);
    const { error } = await b.client.insert('chat_messages', { user_id: a.userId, role: 'user', content: 'spoof' });
    expect(error).not.toBeNull();
    expect(await moveAction(a.client, a.userId, act.id, 'pending', 'cancelled')).toBe(true);
  });

  it('moves an action only from the expected status, once', async () => {
    const act = await createAction(a.client, a.userId, { tool: 'submit_timesheet', args: {}, status: 'pending', expiresAt: new Date(NOW.getTime() + 600_000) });
    expect((await latestPending(a.client, a.userId, NOW))?.id).toBe(act.id);
    expect(await moveAction(a.client, a.userId, act.id, 'pending', 'done', { before: 1 })).toBe(true);
    expect(await moveAction(a.client, a.userId, act.id, 'pending', 'done')).toBe(false);
    expect(await getAction(a.client, a.userId, act.id)).toMatchObject({ status: 'done', undo: { before: 1 } });
    expect(await latestPending(a.client, a.userId, NOW)).toBeNull();
  });

  it('ignores pending actions that have expired', async () => {
    await createAction(a.client, a.userId, { tool: 'recall_timesheet', args: {}, status: 'pending', expiresAt: new Date(NOW.getTime() - 1000) });
    expect(await latestPending(a.client, a.userId, NOW)).toBeNull();
  });
});
