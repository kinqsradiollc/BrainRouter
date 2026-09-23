/**
 * ADR-047 D2 (P2) — an installed coding-agent CLI drives the main-loop turn.
 *
 * Execution is ONE-SHOT read-until-exit (matching real agents: `claude -p`,
 * `codex exec`). These exercise the transport executor with an INJECTED fake
 * child process: the whole answer is collected, both output protocols parse,
 * abort KILLS the child (Stop lands), and the two bugs an adversarial review
 * found are pinned — a >64KB prompt with a broken stdin pipe must NOT crash, and
 * a leading blank line in the output must NOT be dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  runExternalAgentTurn,
  callExternalAgentEngine,
  resolveEngineTarget,
  extractEngineOutput,
  flattenMessagesToPrompt,
  type EngineTarget,
} from '../agent/transport/externalAgentEngine.js';
import { setCliKnobOverride, _resetCliKnobsCache } from '../config/config.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (d: string, cb?: (e?: Error) => void) => boolean; end: () => void };
  kill: (sig?: string) => boolean;
  killed: boolean;
  exitCode: number | null;
}

/** A spawn that emits stdout chunks then exits (read-until-exit), or hangs (for abort). */
function fakeSpawn(opts: {
  chunks?: string[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
  spawnError?: Error;
  stdinError?: Error;
}): { spawn: any; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 143; return true; };
  const stdin = new EventEmitter() as FakeChild['stdin'];
  stdin.write = (_d, cb) => {
    if (opts.stdinError) { setImmediate(() => stdin.emit('error', opts.stdinError!)); cb?.(opts.stdinError); }
    else cb?.();
    return true;
  };
  stdin.end = () => {};
  child.stdin = stdin;
  const spawn = (): FakeChild => {
    if (opts.spawnError) { setImmediate(() => child.emit('error', opts.spawnError!)); return child; }
    setImmediate(() => {
      for (const c of opts.chunks ?? []) child.stdout.emit('data', Buffer.from(c));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      if (!opts.hang) { child.exitCode = opts.exitCode ?? 0; child.emit('exit', opts.exitCode ?? 0); }
    });
    return child;
  };
  return { spawn, child };
}

const stdioAgent: EngineTarget = { name: 'ada', command: 'ada-cli', args: ['-p'], protocol: 'stdio' };
const jsonAgent: EngineTarget = { name: 'jules', command: 'jules', args: [], protocol: 'line-json' };
const argAgent: EngineTarget = { name: 'oc', command: 'opencode', args: ['run', '{prompt}'], protocol: 'stdio' };

test('read-until-exit: the whole multi-line stdout is the answer', async () => {
  const { spawn } = fakeSpawn({ chunks: ['line one\n', 'line two\n'] });
  assert.equal(await runExternalAgentTurn(stdioAgent, 'q', { spawnImpl: spawn }), 'line one\nline two');
});

test('a LEADING BLANK LINE in a single chunk is not dropped (review finding)', async () => {
  const { spawn } = fakeSpawn({ chunks: ['\nthe answer\n'] });
  assert.equal(await runExternalAgentTurn(stdioAgent, 'q', { spawnImpl: spawn }), 'the answer');
});

test('line-json: the JSON envelope is parsed for {output}', async () => {
  const { spawn } = fakeSpawn({ chunks: ['some log line\n', `${JSON.stringify({ output: 'json answer' })}\n`] });
  assert.equal(await runExternalAgentTurn(jsonAgent, 'q', { spawnImpl: spawn }), 'json answer');
});

test('line-json: an {error} envelope rejects', async () => {
  const { spawn } = fakeSpawn({ chunks: [`${JSON.stringify({ error: 'model unavailable' })}\n`] });
  await assert.rejects(runExternalAgentTurn(jsonAgent, 'q', { spawnImpl: spawn }), /model unavailable/);
});

test('a broken stdin pipe (EPIPE) does NOT crash — it is swallowed (review HIGH finding)', async () => {
  // The agent replies + exits while a big prompt is still flushing; stdin errors.
  const { spawn } = fakeSpawn({ chunks: ['answer\n'], stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
  // Must resolve cleanly, and the unhandled 'error' must not have propagated.
  assert.equal(await runExternalAgentTurn(stdioAgent, 'x'.repeat(70_000), { spawnImpl: spawn }), 'answer');
});

test('a {prompt} arg is substituted (no stdin) — prompt-as-arg agents', async () => {
  const { spawn } = fakeSpawn({ chunks: ['done\n'] });
  let capturedArgs: string[] = [];
  const wrapped = (cmd: string, args: string[], o: unknown) => { capturedArgs = args; return spawn(cmd, args, o); };
  assert.equal(await runExternalAgentTurn(argAgent, 'hello world', { spawnImpl: wrapped as never }), 'done');
  assert.deepEqual(capturedArgs, ['run', 'hello world']);
});

test('an abort KILLS the child and rejects — Stop lands (ADR-047 §5.2)', async () => {
  const { spawn, child } = fakeSpawn({ hang: true });
  const controller = new AbortController();
  const p = runExternalAgentTurn(stdioAgent, 'q', { spawnImpl: spawn, signal: controller.signal });
  controller.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(child.killed, true, 'the subprocess was SIGTERM-ed on abort');
});

test('an already-aborted signal rejects before spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  const { spawn } = fakeSpawn({ chunks: ['unused\n'] });
  await assert.rejects(runExternalAgentTurn(stdioAgent, 'q', { spawnImpl: spawn, signal: controller.signal }), /aborted/);
});

test('a spawn error rejects', async () => {
  const { spawn } = fakeSpawn({ spawnError: new Error('ENOENT ada-cli') });
  await assert.rejects(runExternalAgentTurn(stdioAgent, 'q', { spawnImpl: spawn }), /ENOENT/);
});

test('no output surfaces stderr in the error', async () => {
  const { spawn } = fakeSpawn({ chunks: [], stderr: 'boom: bad flag', exitCode: 2 });
  await assert.rejects(runExternalAgentTurn(stdioAgent, 'q', { spawnImpl: spawn }), /boom: bad flag/);
});

test('extractEngineOutput: stdio returns raw; line-json finds the last envelope', () => {
  assert.deepEqual(extractEngineOutput('a\nb\n', 'stdio'), { output: 'a\nb\n' });
  assert.deepEqual(extractEngineOutput('log\n{"output":"final"}\n', 'line-json'), { output: 'final' });
  assert.deepEqual(extractEngineOutput('no json here', 'line-json'), { output: 'no json here' });
});

test('resolveEngineTarget finds a configured hosted agent by model name', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ agents: { hosted: [{ name: 'jules', command: 'jules', args: [], protocol: 'line-json' }] } });
  try {
    assert.equal(resolveEngineTarget({ model: 'jules' } as never)?.protocol, 'line-json');
    assert.equal(resolveEngineTarget({ model: 'nope' } as never), undefined);
  } finally {
    _resetCliKnobsCache();
  }
});

test('callExternalAgentEngine maps the answer to the terminal shape + emits one delta', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ agents: { hosted: [{ name: 'ada', command: 'ada-cli', args: ['-p'], protocol: 'stdio' }] } });
  try {
    const { spawn } = fakeSpawn({ chunks: ['engine says hi\n'] });
    const deltas: string[] = [];
    const res = await callExternalAgentEngine(
      { model: 'ada', provider: 'external-agent', apiKey: '', endpoint: '' } as never,
      [{ role: 'user', content: 'hello' }],
      { spawnImpl: spawn, onTextDelta: (d) => deltas.push(d) },
    );
    assert.deepEqual(res, { content: 'engine says hi', toolCalls: undefined, usage: undefined, finishReason: 'stop' });
    assert.deepEqual(deltas, ['engine says hi']);
  } finally {
    _resetCliKnobsCache();
  }
});

test('callExternalAgentEngine fails clearly for an unknown / uninstalled engine model', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ agents: { hosted: [] } });
  try {
    await assert.rejects(
      callExternalAgentEngine({ model: 'ghost', provider: 'external-agent', apiKey: '', endpoint: '' } as never, []),
      /not available/,
    );
  } finally {
    _resetCliKnobsCache();
  }
});

test('flattenMessagesToPrompt renders a readable transcript, dropping empties', () => {
  const out = flattenMessagesToPrompt([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '' },
  ]);
  assert.match(out, /SYSTEM: be terse/);
  assert.match(out, /USER: hi/);
  assert.doesNotMatch(out, /ASSISTANT:/);
});
