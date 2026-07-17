/**
 * Wire integration test — the REAL RemoteTransport (the mobile WS client) talking
 * to the REAL host server (host/server.mjs) over loopback sockets, with the
 * Node-only desktop agent runtime replaced by a scripted stub. This exercises the
 * actual path the phone uses, end-to-end:
 *   - the `hello` handshake on (re)connect,
 *   - query() ↔ query-result correlation by id,
 *   - streamed AgentEvents reaching onEvent,
 *   - and the WF-7 replay ring resuming a client that dropped.
 * None of which the unit tests (fake socket) or the headless typecheck/bundle can
 * prove. The agent business logic is stubbed on purpose — it is separately
 * typecheck-verified and is meant to run under the WSL host, not here.
 *
 * Run:  npm run test:wire   (tsx --test host/wire.integration.test.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startHostServer } from './server.mjs';
import { RemoteTransport } from '../src/transport/RemoteTransport.ts';

// ws's client is browser-WebSocket compatible (onopen/onmessage/onclose/send/…),
// which is exactly the surface RemoteTransport drives on-device.
const WSImpl = WebSocket;

/** A scripted stand-in for brainrouter-desktop host.ts `main(transport)`. */
function fakeAgentHost() {
  let seq = 0;
  let send = () => {};
  const main = (transport) => {
    send = transport.send;
    transport.onMessage((m) => {
      if (m && m.kind === 'query') {
        // Mirror a queries-map hit: resolve every query with a deterministic result.
        const result =
          m.name === 'list-models'
            ? { models: ['claude-opus-4-8'] }
            : m.name === 'workspace-recents'
              ? { current: '/repo', recents: ['/repo'] }
              : { echo: m.name, args: m.args };
        transport.send({ seq: ++seq, ts: 0, sessionKey: 's', event: { kind: 'query-result', id: m.id, ok: true, result } });
      } else if (m && m.kind === 'start-turn') {
        if (m.approve) {
          // Mirror UF-03: pause the turn for a human decision (raises the sheet).
          transport.send({
            seq: ++seq,
            ts: 0,
            sessionKey: 's',
            event: { kind: 'interaction-request', request: { id: 'req-1', type: 'confirm', title: 'Run the tests?', tool: 'bash' } },
          });
        } else {
          // Mirror the core loop: stream a tiny assistant turn.
          transport.send({ seq: ++seq, ts: 0, sessionKey: 's', event: { kind: 'assistant-delta', text: 'hi' } });
          transport.send({ seq: ++seq, ts: 0, sessionKey: 's', event: { kind: 'turn-end' } });
        }
      } else if (m && m.kind === 'interaction-response') {
        // The human approved over the wire → resume and finish the turn.
        transport.send({ seq: ++seq, ts: 0, sessionKey: 's', event: { kind: 'tool-result', id: m.id, ok: true } });
        transport.send({ seq: ++seq, ts: 0, sessionKey: 's', event: { kind: 'turn-end' } });
      }
    });
  };
  return {
    main,
    emit: (event) => {
      send({ seq: ++seq, ts: 0, sessionKey: 's', event });
      return seq;
    },
  };
}

async function waitUntil(cond, label = 'condition', timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('query() round-trips over a real WebSocket to the host', async () => {
  const host = fakeAgentHost();
  const srv = await startHostServer({ port: 0, main: host.main, exitOnFatal: false });
  const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WSImpl });
  try {
    await waitUntil(() => t.status() === 'connected', 'connect');
    assert.deepEqual(await t.query('list-models'), { models: ['claude-opus-4-8'] });
    assert.deepEqual(await t.workspaceRecents(), { current: '/repo', recents: ['/repo'] });
  } finally {
    t.dispose();
    await srv.close();
  }
});

test('streamed agent events arrive over the wire (onEvent)', async () => {
  const host = fakeAgentHost();
  const srv = await startHostServer({ port: 0, main: host.main, exitOnFatal: false });
  const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WSImpl });
  const kinds = [];
  t.onEvent((m) => kinds.push(m.event.kind));
  try {
    await waitUntil(() => t.status() === 'connected', 'connect');
    t.send({ kind: 'start-turn', text: 'hello' });
    await waitUntil(() => kinds.includes('turn-end'), 'turn-end');
    assert.ok(kinds.includes('assistant-delta'), 'received assistant-delta');
  } finally {
    t.dispose();
    await srv.close();
  }
});

test('approval round-trips over the wire (UF-03: send → stream → approve → resume)', async () => {
  const host = fakeAgentHost();
  const srv = await startHostServer({ port: 0, main: host.main, exitOnFatal: false });
  const events = [];
  const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WSImpl });
  t.onEvent((m) => events.push(m.event));
  try {
    await waitUntil(() => t.status() === 'connected', 'connect');
    // 1. Send a turn that needs a human decision.
    t.send({ kind: 'start-turn', text: 'run the tests', approve: true });
    // 2. The host streams an interaction-request → the ApprovalSheet would auto-present.
    await waitUntil(() => events.some((e) => e.kind === 'interaction-request'), 'interaction-request');
    const req = events.find((e) => e.kind === 'interaction-request').request;
    // 3. The human approves → the response goes back to the host over the same socket.
    t.send({ kind: 'interaction-response', id: req.id, response: { type: 'confirm', approved: true } });
    // 4. The host resumes and finishes the turn.
    await waitUntil(() => events.some((e) => e.kind === 'turn-end'), 'turn-end after approval');
    assert.ok(events.some((e) => e.kind === 'tool-result'), 'the tool ran after approval');
  } finally {
    t.dispose();
    await srv.close();
  }
});

test('host replay ring resumes a reconnecting client with no gaps or dupes (WF-7)', async () => {
  const host = fakeAgentHost();
  const srv = await startHostServer({ port: 0, main: host.main, exitOnFatal: false });
  // Three events produced before anyone is connected → they live only in the ring.
  host.emit({ kind: 'assistant-delta', text: 'one' }); //   seq 1
  host.emit({ kind: 'assistant-delta', text: 'two' }); //   seq 2
  host.emit({ kind: 'assistant-delta', text: 'three' }); // seq 3
  const got = [];
  const raw = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replay timeout')), 4000);
      raw.on('open', () => raw.send(JSON.stringify({ kind: 'hello', afterSeq: 1 })));
      raw.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (typeof msg.seq === 'number') got.push(msg.seq);
        if (got.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      raw.on('error', reject);
    });
    assert.deepEqual(got, [2, 3]); // resumes strictly AFTER seq 1 — gap-free, seq 1 not re-sent
  } finally {
    raw.close();
    await srv.close();
  }
});

test('RemoteTransport auto-reconnects and the host replays what it missed', async () => {
  const host = fakeAgentHost();
  const srv = await startHostServer({ port: 0, main: host.main, exitOnFatal: false });
  const seen = [];
  const t = new RemoteTransport({ url: `ws://127.0.0.1:${srv.port}`, WebSocketImpl: WSImpl, maxBackoffMs: 50 });
  t.onEvent((m) => {
    if (typeof m.seq === 'number') seen.push(m.seq);
  });
  try {
    await waitUntil(() => t.status() === 'connected', 'connect');
    host.emit({ kind: 'assistant-delta', text: 'one' }); // seq 1 (delivered live)
    await waitUntil(() => seen.includes(1), 'seq 1 live');

    // Drop the client's socket from the server side.
    for (const c of srv.wss.clients) c.terminate();
    await waitUntil(() => t.status() !== 'connected', 'client notices the drop');

    host.emit({ kind: 'assistant-delta', text: 'two' }); // seq 2 (offline → ring only)

    // Auto-reconnect → hello(afterSeq=1) → the host replays seq 2 with no gap.
    await waitUntil(() => seen.includes(2), 'seq 2 replayed after reconnect', 6000);
    assert.ok(seen.includes(2), 'replayed the missed event after reconnect');
  } finally {
    t.dispose();
    await srv.close();
  }
});
