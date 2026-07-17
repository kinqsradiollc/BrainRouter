// Unit tests for the RemoteTransport WS client — drives a FAKE WebSocket so the
// query-correlation, status, and dispose logic is verifiable without a live
// `brainrouter-host`. Run via `npm run test:domain` (tsx --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from './RemoteTransport.js';

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // ── test helpers ──
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  lastSentOfKind(kind: string): Record<string, unknown> | undefined {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .reverse()
      .find((m) => m.kind === kind);
  }
}

function make(): { t: RemoteTransport; ws: FakeWebSocket } {
  const t = new RemoteTransport({ url: 'ws://host:3747', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
  return { t, ws: FakeWebSocket.last as FakeWebSocket };
}

test('status goes connecting → connected on open, then offline on close', () => {
  const { t, ws } = make();
  assert.equal(t.status(), 'connecting');
  ws.open();
  assert.equal(t.status(), 'connected');
  ws.close();
  assert.equal(t.status(), 'offline');
  t.dispose();
});

test('on open it sends a hello carrying the last-seen seq (for replay)', () => {
  const { t, ws } = make();
  ws.open();
  const hello = ws.lastSentOfKind('hello');
  assert.ok(hello);
  assert.equal(hello?.afterSeq, 0);
  t.dispose();
});

test('query() resolves when the matching query-result event arrives', async () => {
  const { t, ws } = make();
  ws.open();
  const p = t.query('list-models');
  const sent = ws.lastSentOfKind('query');
  assert.equal(sent?.name, 'list-models');
  ws.emit({ seq: 1, ts: 0, sessionKey: 's', event: { kind: 'query-result', id: sent?.id, ok: true, result: { models: ['opus'] } } });
  assert.deepEqual(await p, { models: ['opus'] });
  t.dispose();
});

test('a failed query-result rejects the promise', async () => {
  const { t, ws } = make();
  ws.open();
  const p = t.query('boom');
  const sent = ws.lastSentOfKind('query');
  ws.emit({ seq: 1, ts: 0, sessionKey: 's', event: { kind: 'query-result', id: sent?.id, ok: false, error: 'nope' } });
  await assert.rejects(p, /nope/);
  t.dispose();
});

test('Layer-1 methods go out as queries on the same channel', async () => {
  const { t, ws } = make();
  ws.open();
  const p = t.workspaceRecents();
  const sent = ws.lastSentOfKind('query');
  assert.equal(sent?.name, 'workspace-recents');
  ws.emit({ seq: 1, ts: 0, sessionKey: 's', event: { kind: 'query-result', id: sent?.id, ok: true, result: { current: '/r', recents: ['/r'] } } });
  assert.deepEqual(await p, { current: '/r', recents: ['/r'] });
  t.dispose();
});

test('onEvent receives streamed event messages', () => {
  const { t, ws } = make();
  ws.open();
  const events: Array<{ event: { kind: string } }> = [];
  t.onEvent((m) => {
    events.push(m as unknown as { event: { kind: string } });
  });
  ws.emit({ seq: 5, ts: 0, sessionKey: 's', event: { kind: 'assistant-delta', text: 'hi' } });
  assert.equal(events[0]?.event.kind, 'assistant-delta');
  t.dispose();
});

test('dispose rejects any pending queries', async () => {
  const { t, ws } = make();
  ws.open();
  const p = t.query('hangs');
  t.dispose();
  await assert.rejects(p, /disposed/);
});
