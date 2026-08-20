// ADR-041 A41-15 (W3) — external-agent subagent provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  spawnExternalCliWorker,
  hostedAgentExistsForRole,
  type ExternalWorkerRuntime,
} from '../agent/subprocess/externalCliSubprocess.js';
import { readWorkerMeta, readWorkerSummary } from '../worker/workerStore.js';
import { childAgentsFor } from '../orchestration/tools/registry.js';
import type { SpawnWorkerInput } from '../orchestration/agents/workerTools.js';

const tmpWs = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'extcli-'));

function inputFor(ws: string, role = 'external-reviewer'): SpawnWorkerInput {
  return {
    workspaceRoot: ws, launchCwd: ws, role, goal: 'summarize the diff',
    parentSessionKey: 'sess:parent', spawnerDepth: 0,
  };
}

/** A fake runtime whose exec resolves to a canned output; records lifecycle calls. */
function fakeRuntime(output: string): ExternalWorkerRuntime & { started: boolean; disposed: boolean } {
  const r = {
    started: false, disposed: false,
    async start() { r.started = true; },
    async exec() { return { output }; },
    async dispose() { r.disposed = true; },
  };
  return r;
}

async function waitForStatus(ws: string, id: string, want: string, ms = 2000): Promise<void> {
  for (let i = 0; i < ms / 10; i++) {
    if (readWorkerMeta(ws, id)?.status === want) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`worker ${id} never reached status ${want} (was ${readWorkerMeta(ws, id)?.status})`);
}

test('A41-15 — an external worker runs the CLI and writes its summary + completed status back', async () => {
  const ws = tmpWs();
  const rt = fakeRuntime('the diff is safe to merge');
  const meta = spawnExternalCliWorker(inputFor(ws), () => rt);
  assert.equal(meta.status, 'running', 'returns immediately with a running worker');
  await waitForStatus(ws, meta.id, 'completed');
  assert.equal(readWorkerSummary(ws, meta.id), 'the diff is safe to merge');
  assert.ok(rt.started && rt.disposed, 'the runtime was started and disposed');
});

test('A41-15 — an external worker that throws is recorded as failed, not left running', async () => {
  const ws = tmpWs();
  const rt: ExternalWorkerRuntime = {
    async start() {},
    async exec() { throw new Error('cli exited 1'); },
    async dispose() {},
  };
  const meta = spawnExternalCliWorker(inputFor(ws), () => rt);
  await waitForStatus(ws, meta.id, 'failed');
  assert.equal(readWorkerMeta(ws, meta.id)?.status, 'failed');
});

test('A41-15 — an external worker is on the interrupt cascade: a parent Stop disposes its process', async () => {
  const ws = tmpWs();
  let disposed = false;
  // A runtime that blocks in exec until disposed, so we can catch it mid-run.
  const rt: ExternalWorkerRuntime = {
    async start() {},
    exec: () => new Promise((resolve) => {
      const timer = setInterval(() => { if (disposed) { clearInterval(timer); resolve({ output: 'interrupted' }); } }, 5);
    }),
    async dispose() { disposed = true; },
  };
  const meta = spawnExternalCliWorker(inputFor(ws), () => rt);
  // While running, the parent's interrupt cascade sees it and can stop it.
  const children = childAgentsFor('sess:parent');
  assert.equal(children.length, 1, 'the external worker is registered on the interrupt cascade');
  children[0].requestInterrupt();
  await waitForStatus(ws, meta.id, 'completed');
  assert.equal(disposed, true, 'requestInterrupt disposed the external runtime');
});

test('A41-15 — hostedAgentExistsForRole is false with no hosted agents configured (byte-neutral default)', () => {
  assert.equal(hostedAgentExistsForRole('external-reviewer'), false);
});
