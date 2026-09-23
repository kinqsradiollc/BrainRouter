/**
 * ADR-050 P2b/P2c — the JSON-RPC stdio transports: Codex `app-server` and ACP.
 *
 * A scriptable JSON-RPC fake answers each request (initialize / thread-or-session
 * / turn-or-prompt) and can stream notifications in between, proving: the
 * handshake captures the resumable id, notifications stream text + tool, the turn
 * resolves off the request response, an ACP permission REQUEST routes to
 * onPermission and answers with the selected option (default-deny with none),
 * and interrupt ends the turn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAgentSession, normalizeCodexEvent, normalizeAcpUpdate, acpPermissionOutcome,
  type AgentSessionEvent, type SessionPermissionRequest,
} from '../agent/session/index.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A fake child whose stdin parses JSON-RPC requests and lets the script emit responses/notifications. */
function jsonRpcFake(onRequest: (method: string, id: unknown, params: any, emit: (o: unknown) => void) => void) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.killed = false; child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 143; setImmediate(() => child.emit('exit', 143)); return true; };
  const emit = (o: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  child.stdin = {
    on: () => {},
    end: () => {},
    write: (d: string, cb?: (e?: Error) => void) => {
      try { const m = JSON.parse(d.trim()); if (m.method && m.id !== undefined) onRequest(m.method, m.id, m.params, emit); } catch { /* not a request */ }
      cb?.(); return true;
    },
  };
  const spawn = (() => child) as any;
  return { spawn, child, emit };
}

test('normalizers: codex agent_message_delta/exec + acp chunk/tool + permission outcome', () => {
  assert.deepEqual(normalizeCodexEvent({ msg: { type: 'agent_message_delta', delta: 'x' } }), [{ t: 'text', text: 'x' }]);
  assert.deepEqual(normalizeCodexEvent({ msg: { type: 'exec_command_begin', command: 'ls' } }), [{ t: 'tool', name: 'ls' }]);
  assert.deepEqual(normalizeAcpUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }), [{ t: 'text', text: 'hi' }]);
  assert.deepEqual(normalizeAcpUpdate({ update: { sessionUpdate: 'tool_call', title: 'Read file' } }), [{ t: 'tool', name: 'Read file' }]);
  const opts = { options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'b', kind: 'allow_always' }, { optionId: 'c', kind: 'reject_once' }] };
  assert.deepEqual(acpPermissionOutcome('approved', opts), { outcome: { outcome: 'selected', optionId: 'a' } });
  assert.deepEqual(acpPermissionOutcome('approved-for-session', opts), { outcome: { outcome: 'selected', optionId: 'b' } });
  assert.deepEqual(acpPermissionOutcome('declined', opts), { outcome: { outcome: 'selected', optionId: 'c' } });
});

test('codex-app-server: handshake captures thread id, notifications stream, turn resolves stop', async () => {
  const io = jsonRpcFake((method, id, _params, emit) => {
    if (method === 'initialize') emit({ jsonrpc: '2.0', id, result: {} });
    else if (method === 'thread/start') emit({ jsonrpc: '2.0', id, result: { thread_id: 'th-1' } });
    else if (method === 'turn/start') {
      emit({ jsonrpc: '2.0', method: 'codex/event', params: { msg: { type: 'agent_message_delta', delta: 'Hi ' } } });
      emit({ jsonrpc: '2.0', method: 'codex/event', params: { msg: { type: 'exec_command_begin', command: 'ls' } } });
      emit({ jsonrpc: '2.0', method: 'codex/event', params: { msg: { type: 'agent_message_delta', delta: 'there' } } });
      emit({ jsonrpc: '2.0', id, result: {} });
    }
  });
  const s = createAgentSession('codex-app-server', { command: 'codex', args: [] }, { spawnImpl: io.spawn });
  const events: AgentSessionEvent[] = [];
  const turn = await s.prompt('hey', { onEvent: (e) => events.push(e) });
  assert.deepEqual(turn, { text: 'Hi there', reason: 'stop' });
  assert.equal(s.resumeCursor, 'th-1');
  assert.ok(events.some((e) => e.kind === 'session' && e.sessionId === 'th-1'));
  assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'ls'));
  assert.equal(events.at(-1)!.kind, 'done');
  await s.close();
});

test('acp-stdio: a permission request routes to onPermission and answers with the option', async () => {
  const asked: SessionPermissionRequest[] = [];
  const io = jsonRpcFake((method, id, _params, emit) => {
    if (method === 'initialize') emit({ jsonrpc: '2.0', id, result: {} });
    else if (method === 'session/new') emit({ jsonrpc: '2.0', id, result: { sessionId: 'acp-1' } });
    else if (method === 'session/prompt') {
      emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
      // agent asks permission (a REQUEST to us, id 99); we answer, then finish.
      emit({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { toolCall: { toolCallId: 't1', kind: 'execute', title: 'Run ls' }, options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
      emit({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
  });
  const s = createAgentSession('acp-stdio', { command: 'gemini', args: ['--experimental-acp'] }, { spawnImpl: io.spawn });
  const events: AgentSessionEvent[] = [];
  const turn = await s.prompt('do it', {
    onEvent: (e) => events.push(e),
    onPermission: async (r) => { asked.push(r); return 'approved'; },
  });
  await tick();
  assert.equal(turn.reason, 'stop');
  assert.equal(turn.text, 'ok');
  assert.equal(s.resumeCursor, 'acp-1');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.kind, 'command');
  assert.equal(asked[0]!.title, 'Run ls');
  await s.close();
});

test('acp-stdio: with NO onPermission handler the request default-denies', async () => {
  let answered: any;
  const io = jsonRpcFake((method, id, _params, emit) => {
    if (method === 'initialize') emit({ jsonrpc: '2.0', id, result: {} });
    else if (method === 'session/new') emit({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
    else if (method === 'session/prompt') {
      emit({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: { toolCall: { toolCallId: 't', kind: 'edit', title: 'Edit' }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] } });
      emit({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
  });
  // capture what we send back for the id-42 request
  const origWrite = io.child.stdin.write;
  io.child.stdin.write = (d: string, cb?: any) => { try { const m = JSON.parse(d.trim()); if (m.id === 42) answered = m.result; } catch {} return origWrite(d, cb); };
  const s = createAgentSession('acp-stdio', { command: 'gemini', args: [] }, { spawnImpl: io.spawn });
  await s.prompt('x', { onEvent: () => {} });
  await tick();
  assert.deepEqual(answered, { outcome: { outcome: 'selected', optionId: 'n' } }, 'default-denied by selecting reject_once');
  await s.close();
});
