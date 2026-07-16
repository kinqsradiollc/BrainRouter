/**
 * Auth integration test — proves the host WS server enforces device-token
 * authentication (CWE-306) and can't be crashed by a throwing agent handler
 * (CWE-248). Uses a raw `ws` client (no RemoteTransport) so we can drive the
 * exact handshake bytes, and a minimal inline `main` stub for the agent host.
 *
 * Run:  cd brainrouter-mobile && node --test host/auth.integration.test.mjs
 * (Plain JS — needs only `ws`, no tsx/TypeScript.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startHostServer, tokenMatches, isLoopbackHost } from './server.mjs';

/** Minimal agent-host stub: answers `query` frames; throws on a `boom` frame. */
function fakeMain() {
  let seq = 0;
  return (transport) => {
    transport.onMessage((m) => {
      if (m && m.kind === 'boom') throw new Error('handler boom'); // isolation probe
      if (m && m.kind === 'query') {
        transport.send({
          seq: ++seq, ts: 0, sessionKey: 's',
          event: { kind: 'query-result', id: m.id, ok: true, result: { echo: m.name } },
        });
      }
    });
  };
}

function open(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
/** Resolve with the first inbound message matching `pred`; reject on timeout. */
function nextMsg(ws, pred = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(String(d)); } catch { return; }
      if (pred(m)) { clearTimeout(timer); resolve(m); }
    });
  });
}
function nextClose(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

test('tokenMatches: constant-time equality with length + empty guards', () => {
  assert.equal(tokenMatches('s3cret', 's3cret'), true);
  assert.equal(tokenMatches('s3cret', 'nope'), false);   // same length, different value
  assert.equal(tokenMatches('s3cret', 's3cre'), false);  // different length
  assert.equal(tokenMatches('s3cret', ''), false);       // empty provided
  assert.equal(tokenMatches('s3cret', undefined), false);// missing provided
  assert.equal(tokenMatches('', 'anything'), false);     // no expected → never matches here
});

test('isLoopbackHost recognises loopback binds only', () => {
  for (const h of ['127.0.0.1', '::1', 'localhost']) assert.equal(isLoopbackHost(h), true);
  for (const h of ['0.0.0.0', '::', '192.168.1.20']) assert.equal(isLoopbackHost(h), false);
});

test('startHostServer refuses a non-loopback bind without a token (CWE-306)', async () => {
  await assert.rejects(
    () => startHostServer({ port: 0, host: '0.0.0.0', token: '', main: fakeMain(), exitOnFatal: false }),
    /BRAINROUTER_HOST_TOKEN/,
  );
});

test('a hello with the wrong token is rejected (close 4001) and no command is served', async () => {
  const srv = await startHostServer({ port: 0, host: '127.0.0.1', token: 's3cret', main: fakeMain(), exitOnFatal: false });
  const ws = await open(`ws://127.0.0.1:${srv.port}`);
  try {
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ kind: 'hello', token: 'WRONG', afterSeq: 0 }));
    assert.equal(await closed, 4001);
  } finally { try { ws.close(); } catch { /* */ } await srv.close(); }
});

test('a hello with the correct token authenticates; queries round-trip', async () => {
  const srv = await startHostServer({ port: 0, host: '127.0.0.1', token: 's3cret', main: fakeMain(), exitOnFatal: false });
  const ws = await open(`ws://127.0.0.1:${srv.port}`);
  try {
    ws.send(JSON.stringify({ kind: 'hello', token: 's3cret', afterSeq: 0 }));
    ws.send(JSON.stringify({ kind: 'query', id: 'q1', name: 'list-models', args: {} }));
    const res = await nextMsg(ws, (m) => m.event && m.event.kind === 'query-result');
    assert.equal(res.event.ok, true);
    assert.deepEqual(res.event.result, { echo: 'list-models' });
  } finally { try { ws.close(); } catch { /* */ } await srv.close(); }
});

test('commands received before a valid hello are dropped (auth gate)', async () => {
  const srv = await startHostServer({ port: 0, host: '127.0.0.1', token: 's3cret', main: fakeMain(), exitOnFatal: false });
  const ws = await open(`ws://127.0.0.1:${srv.port}`);
  try {
    // A query BEFORE authenticating must be ignored → no result comes back.
    ws.send(JSON.stringify({ kind: 'query', id: 'early', name: 'list-models', args: {} }));
    await assert.rejects(nextMsg(ws, (m) => m.event && m.event.id === 'early', 400), /timeout/);
    // After a valid hello the same query is served.
    ws.send(JSON.stringify({ kind: 'hello', token: 's3cret', afterSeq: 0 }));
    ws.send(JSON.stringify({ kind: 'query', id: 'late', name: 'list-models', args: {} }));
    const res = await nextMsg(ws, (m) => m.event && m.event.id === 'late');
    assert.equal(res.event.ok, true);
  } finally { try { ws.close(); } catch { /* */ } await srv.close(); }
});

test('no token on a loopback bind → backward-compatible (hello without token works)', async () => {
  const srv = await startHostServer({ port: 0, host: '127.0.0.1', token: '', main: fakeMain(), exitOnFatal: false });
  const ws = await open(`ws://127.0.0.1:${srv.port}`);
  try {
    ws.send(JSON.stringify({ kind: 'hello', afterSeq: 0 })); // no token field at all
    ws.send(JSON.stringify({ kind: 'query', id: 'q1', name: 'list-models', args: {} }));
    const res = await nextMsg(ws, (m) => m.event && m.event.id === 'q1');
    assert.equal(res.event.ok, true);
  } finally { try { ws.close(); } catch { /* */ } await srv.close(); }
});

test('a throwing agent handler does not crash the server (per-message isolation, CWE-248)', async () => {
  const srv = await startHostServer({ port: 0, host: '127.0.0.1', token: '', main: fakeMain(), exitOnFatal: false });
  const ws = await open(`ws://127.0.0.1:${srv.port}`);
  try {
    ws.send(JSON.stringify({ kind: 'hello', afterSeq: 0 }));  // loopback, no token → authed
    ws.send(JSON.stringify({ kind: 'boom' }));                // handler throws — must be swallowed
    ws.send(JSON.stringify({ kind: 'query', id: 'q1', name: 'list-models', args: {} }));
    const res = await nextMsg(ws, (m) => m.event && m.event.id === 'q1');
    assert.equal(res.event.ok, true);                         // server survived the boom
  } finally { try { ws.close(); } catch { /* */ } await srv.close(); }
});
