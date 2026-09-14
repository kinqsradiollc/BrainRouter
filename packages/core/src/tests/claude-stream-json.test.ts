/**
 * ADR-050 P2a — the Claude Code `stream-json` transport: a pure line parser plus
 * a persistent session state machine. The session is driven through a real
 * stream-json exchange (system/init → assistant text+tool → result) with an
 * injected controllable child, proving: text streams, tool activity narrates,
 * the session id is captured as resumeCursor, is_error settles as error,
 * interrupt kills + ends interrupted, and the process is REUSED across turns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAgentSession,
  parseClaudeStreamLine,
  type AgentSessionEvent,
} from '../agent/session/index.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter; stderr: EventEmitter;
  stdin: { write: (d: string, cb?: (e?: Error) => void) => boolean; end: () => void; on: () => void };
  kill: (sig?: string) => boolean; killed: boolean; exitCode: number | null;
}
function controllable() {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.killed = false; child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 143; setImmediate(() => child.emit('exit', 143)); return true; };
  const written: string[] = [];
  child.stdin = { write: (d, cb) => { written.push(d); cb?.(); return true; }, end: () => {}, on: () => {} };
  let spawnCount = 0;
  const spawn = ((): FakeChild => { spawnCount += 1; return child; }) as any;
  return {
    spawn, child, written,
    spawns: () => spawnCount,
    emit: (obj: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')),
  };
}

const spec = { command: 'claude', args: [] as const };

test('parseClaudeStreamLine normalizes init / assistant / result lines', () => {
  assert.deepEqual(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })), [{ t: 'session', sessionId: 's1' }]);
  assert.deepEqual(
    parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: {} }] } })),
    [{ t: 'text', text: 'hi' }, { t: 'tool', name: 'Read' }],
  );
  assert.deepEqual(parseClaudeStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 's1', is_error: false })), [{ t: 'result', text: 'done', isError: false, sessionId: 's1' }]);
  const errItem = parseClaudeStreamLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }))[0]!;
  assert.ok(errItem.t === 'result' && errItem.isError === true);
  assert.deepEqual(parseClaudeStreamLine('not json'), []);
});

test('a full turn streams text + tool, captures the session id, and resolves stop', async () => {
  const io = controllable();
  const s = createAgentSession('claude-stream-json', spec, { spawnImpl: io.spawn });
  const events: AgentSessionEvent[] = [];
  const turnP = s.prompt('hello', { onEvent: (e) => events.push(e) });
  await tick();
  assert.ok(io.written.some((w) => w.includes('"type":"user"') && w.includes('hello')), 'wrote a stream-json user message');
  io.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  io.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hel' }] } });
  io.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } });
  io.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'lo' }] } });
  io.emit({ type: 'result', subtype: 'success', result: 'Hello', session_id: 'sess-1', is_error: false });
  const turn = await turnP;
  assert.deepEqual(turn, { text: 'Hello', reason: 'stop' });
  assert.equal(s.resumeCursor, 'sess-1');
  assert.deepEqual(events, [
    { kind: 'session', sessionId: 'sess-1' },
    { kind: 'text', delta: 'Hel' },
    { kind: 'tool', phase: 'start', name: 'Read' },
    { kind: 'text', delta: 'lo' },
    { kind: 'done', reason: 'stop' },
  ]);
});

test('is_error result settles the turn as error', async () => {
  const io = controllable();
  const s = createAgentSession('claude-stream-json', spec, { spawnImpl: io.spawn });
  const events: AgentSessionEvent[] = [];
  const turnP = s.prompt('go', { onEvent: (e) => events.push(e) });
  await tick();
  io.child.stderr.emit('data', Buffer.from('rate limited'));
  io.emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
  const turn = await turnP;
  assert.equal(turn.reason, 'error');
  assert.ok(events.some((e) => e.kind === 'done' && e.reason === 'error' && /rate limited/.test(e.error ?? '')));
});

test('the persistent process is reused across turns (spawned once)', async () => {
  const io = controllable();
  const s = createAgentSession('claude-stream-json', spec, { spawnImpl: io.spawn });
  const p1 = s.prompt('one', { onEvent: () => {} });
  await tick();
  io.emit({ type: 'result', subtype: 'success', result: 'a', is_error: false });
  await p1;
  const p2 = s.prompt('two', { onEvent: () => {} });
  await tick();
  io.emit({ type: 'result', subtype: 'success', result: 'b', is_error: false });
  const turn2 = await p2;
  assert.equal(turn2.text, 'b');
  assert.equal(io.spawns(), 1, 'the child was spawned once and reused');
  await s.close();
});

test('interrupt ends the turn interrupted and kills the process', async () => {
  const io = controllable();
  const s = createAgentSession('claude-stream-json', spec, { spawnImpl: io.spawn });
  const events: AgentSessionEvent[] = [];
  const turnP = s.prompt('slow', { onEvent: (e) => events.push(e) });
  await tick();
  await s.interrupt();
  const turn = await turnP;
  assert.equal(turn.reason, 'interrupted');
  assert.ok(io.written.some((w) => w.includes('control_request')), 'sent a best-effort protocol interrupt');
  await s.close();
  assert.equal(io.child.killed, true);
});
