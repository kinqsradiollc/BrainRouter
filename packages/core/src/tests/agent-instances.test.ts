/**
 * ADR-050 P5 (D5) — instances, not binaries. A hosted-agent entry is an INSTANCE:
 * the same CLI may appear N times, keyed by the entry `name`, each with its own
 * isolated-home `env` so two seats of one agent never share auth state. These
 * tests pin the resolver's env sanitation and prove the instance env reaches the
 * spawned process (and that two instances get DIFFERENT homes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Config } from '../config/config.js';
import { resolveCliKnobs, setCliKnobOverride, _resetCliKnobsCache } from '../config/config.js';
import { resolveEngineTarget, callExternalAgentEngine } from '../agent/transport/externalAgentEngine.js';

/** A spawn that records the env it was given, then emits one line and exits. */
function capturingSpawn(answer: string): { spawn: any; envs: Array<Record<string, string | undefined>> } {
  const envs: Array<Record<string, string | undefined>> = [];
  const spawn = (_cmd: string, _args: readonly string[], opts: { env?: Record<string, string | undefined> }): EventEmitter => {
    envs.push(opts.env ?? {});
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter;
      stdin: { write: (d: string, cb?: (e?: Error) => void) => boolean; end: () => void; on: () => void };
      kill: () => boolean; killed: boolean; exitCode: number | null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (_d, cb) => { cb?.(); return true; }, end: () => {}, on: () => {} };
    child.kill = () => { child.killed = true; return true; };
    child.killed = false;
    child.exitCode = null;
    setImmediate(() => { child.stdout.emit('data', Buffer.from(`${answer}\n`)); child.exitCode = 0; child.emit('exit', 0); });
    return child;
  };
  return { spawn, envs };
}

test('resolver keeps string→string env, drops non-strings, and drops an empty map', () => {
  // The RESOLVER sanitizes (setCliKnobOverride stores an already-resolved shape
  // verbatim, so exercise resolveCliKnobs against a raw config directly).
  const cfg = {
    cli: {
      agents: {
        hosted: [
          { name: 'claude-a', command: 'claude', args: [], protocol: 'stdio', env: { CLAUDE_CONFIG_DIR: '/homes/a', PORT: 8080, KEEP: 'yes' } },
          { name: 'empty', command: 'claude', args: [], protocol: 'stdio', env: { NOPE: 42 } },
          { name: 'plain', command: 'claude', args: [], protocol: 'stdio' },
        ],
      },
    },
  } as unknown as Config;
  const hosted = resolveCliKnobs(cfg).agents.hosted;
  assert.deepEqual(hosted.find((h) => h.name === 'claude-a')!.env, { CLAUDE_CONFIG_DIR: '/homes/a', KEEP: 'yes' }); // PORT (number) dropped
  assert.equal(hosted.find((h) => h.name === 'empty')!.env, undefined); // no string values ⇒ undefined
  assert.equal(hosted.find((h) => h.name === 'plain')!.env, undefined); // absent ⇒ undefined
});

test('resolveEngineTarget carries the instance env; the routing key is the entry name, not the binary', () => {
  _resetCliKnobsCache();
  setCliKnobOverride({
    agents: {
      hosted: [
        { name: 'claude-work', command: 'claude', args: [], protocol: 'stdio', env: { CLAUDE_CONFIG_DIR: '/homes/work' } },
        { name: 'claude-home', command: 'claude', args: [], protocol: 'stdio', env: { CLAUDE_CONFIG_DIR: '/homes/home' } },
      ],
    },
  });
  try {
    // Same binary (`claude`), two instances, addressed by their distinct names.
    assert.deepEqual(resolveEngineTarget({ model: 'claude-work' } as never)?.env, { CLAUDE_CONFIG_DIR: '/homes/work' });
    assert.deepEqual(resolveEngineTarget({ model: 'claude-home' } as never)?.env, { CLAUDE_CONFIG_DIR: '/homes/home' });
  } finally {
    _resetCliKnobsCache();
  }
});

test('two instances of one CLI spawn with DIFFERENT homes — no shared auth state', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({
    agents: {
      hosted: [
        { name: 'claude-work', command: 'claude', args: [], protocol: 'stdio', env: { CLAUDE_CONFIG_DIR: '/homes/work' } },
        { name: 'claude-home', command: 'claude', args: [], protocol: 'stdio', env: { CLAUDE_CONFIG_DIR: '/homes/home' } },
      ],
    },
  });
  try {
    const cap = capturingSpawn('ok');
    const msgs = [{ role: 'user', content: 'hi' }];
    await callExternalAgentEngine({ model: 'claude-work' } as never, msgs, { spawnImpl: cap.spawn });
    await callExternalAgentEngine({ model: 'claude-home' } as never, msgs, { spawnImpl: cap.spawn });
    assert.equal(cap.envs.length, 2);
    assert.equal(cap.envs[0]!.CLAUDE_CONFIG_DIR, '/homes/work');
    assert.equal(cap.envs[1]!.CLAUDE_CONFIG_DIR, '/homes/home');
    assert.notEqual(cap.envs[0]!.CLAUDE_CONFIG_DIR, cap.envs[1]!.CLAUDE_CONFIG_DIR);
    // The instance env is layered OVER the inherited process env, not a replacement.
    assert.equal(cap.envs[0]!.PATH, process.env.PATH);
    assert.equal(cap.envs[0]!.BRAINROUTER_ENGINE_AGENT, 'claude-work');
  } finally {
    _resetCliKnobsCache();
  }
});
