/**
 * ADR-050 P1 — the AgentSessionPort seam + the one-shot fallback transport.
 *
 * The one-shot session must be byte-identical to the pre-ADR-050 engine spawn:
 * emit the whole answer as one `text` event + a `done` event, resolve with the
 * final text, surface a failure as `done{reason:'error'}`, and interrupt by
 * killing the child (Stop lands). resumeCursor is undefined (no persistent id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAgentSession, OneShotStdioSession, type AgentSessionEvent } from '../agent/session/index.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter; stderr: EventEmitter;
  stdin: EventEmitter & { write: (d: string, cb?: (e?: Error) => void) => boolean; end: () => void };
  kill: (sig?: string) => boolean; killed: boolean; exitCode: number | null;
}
function fakeSpawn(opts: { chunks?: string[]; exitCode?: number; hang?: boolean; spawnError?: Error }): { spawn: any; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.killed = false; child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 143; return true; };
  const stdin = new EventEmitter() as FakeChild['stdin'];
  stdin.write = (_d, cb) => { cb?.(); return true; }; stdin.end = () => {};
  child.stdin = stdin;
  const spawn = (): FakeChild => {
    if (opts.spawnError) { setImmediate(() => child.emit('error', opts.spawnError!)); return child; }
    setImmediate(() => {
      for (const c of opts.chunks ?? []) child.stdout.emit('data', Buffer.from(c));
      if (!opts.hang) { child.exitCode = opts.exitCode ?? 0; child.emit('exit', opts.exitCode ?? 0); }
    });
    return child;
  };
  return { spawn, child };
}

const spec = { command: 'ada-cli', args: ['-p'] as const };

test('factory returns the one-shot fallback; it declares its transport and has no resume cursor', () => {
  const s = createAgentSession('stdio-oneshot', spec);
  assert.ok(s instanceof OneShotStdioSession);
  assert.equal(s.transport, 'stdio-oneshot');
  assert.equal(s.resumeCursor, undefined);
  // An out-of-union transport degrades to one-shot rather than throwing.
  assert.ok(createAgentSession('nonexistent' as never, spec) instanceof OneShotStdioSession);
});

test('prompt emits the whole answer as one text event + done{stop} and resolves with the text', async () => {
  const { spawn } = fakeSpawn({ chunks: ['Hello ', 'world'] });
  const s = createAgentSession('stdio-oneshot', spec, { spawnImpl: spawn });
  await s.open();
  const events: AgentSessionEvent[] = [];
  const turn = await s.prompt('hi', { onEvent: (e) => events.push(e) });
  assert.deepEqual(turn, { text: 'Hello world', reason: 'stop' });
  assert.deepEqual(events, [{ kind: 'text', delta: 'Hello world' }, { kind: 'done', reason: 'stop' }]);
  await s.close();
});

test('a produced-no-output failure surfaces as done{error} with reason error', async () => {
  const { spawn } = fakeSpawn({ chunks: [''], exitCode: 1 });
  const s = createAgentSession('stdio-oneshot', spec, { spawnImpl: spawn });
  const events: AgentSessionEvent[] = [];
  const turn = await s.prompt('hi', { onEvent: (e) => events.push(e) });
  assert.equal(turn.reason, 'error');
  const done = events.find((e) => e.kind === 'done');
  assert.ok(done && done.kind === 'done' && done.reason === 'error' && /no output/.test(done.error ?? ''));
});

test('a spawn error surfaces as done{error}', async () => {
  const { spawn } = fakeSpawn({ spawnError: new Error('ENOENT ada-cli') });
  const s = createAgentSession('stdio-oneshot', spec, { spawnImpl: spawn });
  const events: AgentSessionEvent[] = [];
  const turn = await s.prompt('hi', { onEvent: (e) => events.push(e) });
  assert.equal(turn.reason, 'error');
  assert.ok(events.some((e) => e.kind === 'done' && /ENOENT/.test(e.error ?? '')));
});

test('interrupt kills the child mid-turn and the turn ends interrupted (Stop lands)', async () => {
  const { spawn, child } = fakeSpawn({ hang: true }); // never exits on its own
  const s = createAgentSession('stdio-oneshot', spec, { spawnImpl: spawn });
  const events: AgentSessionEvent[] = [];
  const p = s.prompt('hi', { onEvent: (e) => events.push(e) });
  await new Promise((r) => setImmediate(r)); // let the child spawn
  await s.interrupt();
  const turn = await p;
  assert.equal(turn.reason, 'interrupted');
  assert.equal(child.killed, true);
  assert.ok(events.some((e) => e.kind === 'done' && e.reason === 'interrupted'));
});
