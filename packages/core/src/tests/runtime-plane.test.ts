/**
 * MC-A1 — runtime plane seam: IAgentRuntime port contract (exercised against
 * the `process` backend with an injected fake executor), the backend
 * registry/factory, the durable instance-state store, and the `cli.runtime`
 * knob resolution + hydration. No live Agent/LLM/MCP — the whole point of the
 * seam is that turn execution is injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliKnobs, hydrateCliDefaults } from '../config/config.js';
import { normalizeRuntimeBackend } from '../config/configTypes.js';
import {
  createProcessRuntime,
  agentTurnExecutor,
  resolveRuntime,
  availableRuntimeBackends,
  readRuntimeRecord,
  listRuntimeRecords,
  createRuntimeRecord,
  updateRuntimeRecord,
  removeRuntimeRecord,
  type RuntimeSpec,
  type RuntimeTurn,
} from '../runtime/index.js';
import { withTempWorkspaceAsync, withTempWorkspace } from './_helpers.js';

const cfg = (cli: Record<string, unknown>) => ({ activeServer: '', servers: {}, cli } as any);

function makeSpec(workspaceRoot: string): RuntimeSpec {
  return { workspaceRoot, sessionKey: 'session:runtime-test', role: 'builder', model: 'test-model' };
}

// ---------------------------------------------------------------------------
// Port contract — process backend
// ---------------------------------------------------------------------------

test('MC-A1 port contract: start → ready → exec (delegated) → dispose', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const seen: RuntimeTurn[] = [];
    const rt = createProcessRuntime({
      executeTurn: async (turn) => {
        seen.push(turn);
        return `echo:${turn.prompt}`;
      },
    });
    assert.equal(rt.kind, 'process');
    assert.equal(rt.status(), 'starting');

    await rt.start(makeSpec(ws));
    assert.equal(rt.status(), 'ready');
    // Durable record follows the lifecycle.
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'ready');

    const result = await rt.exec({ prompt: 'hello runtime' });
    assert.equal(result.output, 'echo:hello runtime');
    assert.deepEqual(seen.map((t) => t.prompt), ['hello runtime']);
    assert.equal(rt.status(), 'ready', 'returns to ready after a turn');

    await rt.dispose();
    assert.equal(rt.status(), 'disposed');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'disposed');
    await rt.dispose(); // idempotent
    assert.equal(rt.status(), 'disposed');
  });
});

test('MC-A1 port contract: executor receives the spec; exec is running for the duration', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    let midTurnStatus = '';
    let specSeen: RuntimeSpec | undefined;
    const rt = createProcessRuntime({
      executeTurn: async (_turn, spec) => {
        specSeen = spec;
        midTurnStatus = rt.status();
        return 'ok';
      },
    });
    await rt.start(makeSpec(ws));
    await rt.exec({ prompt: 'x' });
    assert.equal(midTurnStatus, 'running');
    assert.equal(specSeen?.sessionKey, 'session:runtime-test');
    assert.equal(specSeen?.workspaceRoot, ws);
  });
});

test('MC-A1 port contract: pause parks the durable record; resume restores ready', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rt = createProcessRuntime({ executeTurn: async () => 'ok' });
    await rt.start(makeSpec(ws));

    await rt.pause();
    assert.equal(rt.status(), 'parked');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'parked', 'park is durable');
    await rt.pause(); // idempotent
    assert.equal(rt.status(), 'parked');

    // Parked runtimes refuse work until resumed.
    await assert.rejects(() => rt.exec({ prompt: 'nope' }), /cannot exec while 'parked'/);

    await rt.resume();
    assert.equal(rt.status(), 'ready');
    assert.equal(readRuntimeRecord(ws, rt.id)?.status, 'ready');
    const out = await rt.exec({ prompt: 'after resume' });
    assert.equal(out.output, 'ok');
  });
});

test('MC-A1 port contract: guards — exec/pause before start, double start, executor failure', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const rt = createProcessRuntime({ executeTurn: async () => 'ok' });
    await assert.rejects(() => rt.exec({ prompt: 'x' }), /not started/);
    await assert.rejects(() => rt.pause(), /not started/);

    await rt.start(makeSpec(ws));
    await assert.rejects(() => rt.start(makeSpec(ws)), /already started/);

    const failing = createProcessRuntime({
      executeTurn: async () => {
        throw new Error('boom');
      },
    });
    await failing.start(makeSpec(ws));
    await assert.rejects(() => failing.exec({ prompt: 'x' }), /boom/);
    assert.equal(failing.status(), 'error');
    assert.equal(readRuntimeRecord(ws, failing.id)?.status, 'error');
    await failing.dispose(); // dispose still allowed from error
    assert.equal(failing.status(), 'disposed');
  });
});

test('MC-A1 agentTurnExecutor: one-line delegation to Agent.runTurn (prompt + hidden flag)', async () => {
  const calls: Array<{ prompt: string; hidden?: boolean }> = [];
  const fakeAgent = {
    runTurn: async (prompt: string, _callbacks: unknown, opts?: { hiddenPrompt?: boolean }) => {
      calls.push({ prompt, hidden: opts?.hiddenPrompt });
      return `answered:${prompt}`;
    },
  };
  const exec = agentTurnExecutor(fakeAgent as any);
  const out = await exec({ prompt: 'q', hidden: true }, makeSpec('/tmp'));
  assert.equal(out, 'answered:q');
  assert.deepEqual(calls, [{ prompt: 'q', hidden: true }]);
});

// ---------------------------------------------------------------------------
// Registry / factory
// ---------------------------------------------------------------------------

test('MC-A1 resolveRuntime: explicit + defaulted kind → process backend; unknown normalizes to process', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const executeTurn = async () => 'ok';
    assert.deepEqual([...availableRuntimeBackends()].sort(), ['process', 'worktree']);
    assert.equal(resolveRuntime({ executeTurn }, 'process').kind, 'process');
    // Unknown strings validate to 'process' (knob semantics — never a crash).
    assert.equal(resolveRuntime({ executeTurn }, 'container-someday').kind, 'process');
    // No kind → the cli.runtime.backend knob (default 'process').
    const rt = resolveRuntime({ executeTurn });
    assert.equal(rt.kind, 'process');
    await rt.start(makeSpec(ws));
    assert.equal((await rt.exec({ prompt: 'x' })).output, 'ok');
  });
});

test('MC-A2 resolveRuntime: worktree resolves to the isolated worktree backend', () => {
  // (MC-A1 shipped 'worktree' as a valid-but-unregistered knob value; MC-A2
  // registers the backend, so resolving it now succeeds.)
  assert.equal(resolveRuntime({ executeTurn: async () => 'ok' }, 'worktree').kind, 'worktree');
});

// ---------------------------------------------------------------------------
// Durable instance-state store
// ---------------------------------------------------------------------------

test('MC-A1 runtimeStateStore: create/read/update/list/remove round-trip', () => {
  withTempWorkspace((ws) => {
    const a = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:a', now: '2026-07-04T00:00:00.000Z' });
    const b = createRuntimeRecord(ws, { backend: 'process', sessionKey: 's:b', now: '2026-07-04T00:00:01.000Z' });
    assert.match(a.id, /^rt_[0-9a-f]{8}$/);
    assert.equal(a.status, 'starting');
    assert.equal(a.workspaceRoot, ws);

    const parked = updateRuntimeRecord(ws, a.id, { status: 'parked' });
    assert.equal(parked?.status, 'parked');
    assert.equal(parked?.createdAt, a.createdAt, 'createdAt immutable');
    assert.equal(readRuntimeRecord(ws, a.id)?.status, 'parked');

    const listed = listRuntimeRecords(ws);
    assert.deepEqual(listed.map((r) => r.id), [b.id, a.id], 'newest first');

    assert.equal(updateRuntimeRecord(ws, 'rt_missing0', { status: 'ready' }), null);
    assert.equal(readRuntimeRecord(ws, 'rt_missing0'), null);

    removeRuntimeRecord(ws, a.id);
    assert.equal(readRuntimeRecord(ws, a.id), null);
    assert.deepEqual(listRuntimeRecords(ws).map((r) => r.id), [b.id]);
  });
});

// ---------------------------------------------------------------------------
// cli.runtime knob resolution + hydration
// ---------------------------------------------------------------------------

const RUNTIME_KNOB_DEFAULTS = {
  backend: 'process',
  maxLive: 0,
  archiveOnDispose: true,
  archiveMaxMB: 64,
  archiveKeep: 20,
  // MC-A5 — JIT secrets default OFF (raw child env unchanged); 60s leases.
  jitSecrets: false,
  jitSecretTtlMs: 60_000,
};

test('MC-A1 cli.runtime knob: defaults, validation, clamping', () => {
  // Absent block → safe defaults.
  assert.deepEqual(resolveCliKnobs(cfg({})).runtime, RUNTIME_KNOB_DEFAULTS);
  // Valid values pass through.
  assert.deepEqual(
    resolveCliKnobs(cfg({ runtime: { backend: 'worktree', maxLive: 3 } })).runtime,
    { ...RUNTIME_KNOB_DEFAULTS, backend: 'worktree', maxLive: 3 },
  );
  // Invalid backend → 'process' (never silently isolates or crashes).
  assert.equal(resolveCliKnobs(cfg({ runtime: { backend: 'container' } })).runtime.backend, 'process');
  assert.equal(resolveCliKnobs(cfg({ runtime: { backend: 42 } })).runtime.backend, 'process');
  // maxLive clamped to 0..256; junk → default 0.
  assert.equal(resolveCliKnobs(cfg({ runtime: { maxLive: -5 } })).runtime.maxLive, 0);
  assert.equal(resolveCliKnobs(cfg({ runtime: { maxLive: 9_999 } })).runtime.maxLive, 256);
  assert.equal(resolveCliKnobs(cfg({ runtime: { maxLive: 'many' } })).runtime.maxLive, 0);
  // normalizeRuntimeBackend is the single validation point.
  assert.equal(normalizeRuntimeBackend('worktree'), 'worktree');
  assert.equal(normalizeRuntimeBackend('anything-else'), 'process');
  assert.equal(normalizeRuntimeBackend(undefined), 'process');
  // MC-A6 — archive knobs: archiveOnDispose defaults ON, only an explicit
  // `false` turns it off (junk stays safe); MB/keep clamp to sane ranges.
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveOnDispose: false } })).runtime.archiveOnDispose, false);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveOnDispose: 'nope' } })).runtime.archiveOnDispose, true);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveMaxMB: 128 } })).runtime.archiveMaxMB, 128);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveMaxMB: 0 } })).runtime.archiveMaxMB, 1);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveMaxMB: 999_999 } })).runtime.archiveMaxMB, 1024);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveMaxMB: 'big' } })).runtime.archiveMaxMB, 64);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveKeep: 5 } })).runtime.archiveKeep, 5);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveKeep: -3 } })).runtime.archiveKeep, 0);
  assert.equal(resolveCliKnobs(cfg({ runtime: { archiveKeep: 'lots' } })).runtime.archiveKeep, 20);
});

test('MC-A1 cli.runtime knob: hydrates into config.json with safe defaults', () => {
  const { config } = hydrateCliDefaults({ activeServer: '', servers: {} } as any);
  assert.deepEqual((config.cli as any)?.runtime, RUNTIME_KNOB_DEFAULTS);
});
