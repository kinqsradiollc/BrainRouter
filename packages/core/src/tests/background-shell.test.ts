import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  startBackgroundShell,
  getBackgroundShell,
  readBackgroundOutput,
  killBackgroundShell,
  killAllBackgroundShells,
  __resetBackgroundShells,
} from '../exec/runtime/backgroundShell.js';
import { withTempWorkspaceAsync } from './_helpers.js';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('background shell: detaches, logs output, reaches done with exit code 0', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    __resetBackgroundShells();
    const run = startBackgroundShell({ command: 'echo one; echo two', cwd: workspace, workspaceRoot: workspace });
    assert.equal(run.status, 'running');
    assert.ok(run.id.startsWith('bgsh_'));
    await until(() => getBackgroundShell(run.id)?.status !== 'running');
    const done = getBackgroundShell(run.id)!;
    assert.equal(done.status, 'done');
    assert.equal(done.exitCode, 0);
    assert.match(fs.readFileSync(run.logPath, 'utf-8'), /one\ntwo/);
  });
});

test('background shell: failing command → failed + nonzero exit', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    __resetBackgroundShells();
    const run = startBackgroundShell({ command: 'exit 3', cwd: workspace, workspaceRoot: workspace });
    await until(() => getBackgroundShell(run.id)?.status !== 'running');
    const done = getBackgroundShell(run.id)!;
    assert.equal(done.status, 'failed');
    assert.equal(done.exitCode, 3);
  });
});

test('readBackgroundOutput: incremental offsets + complete flag', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    __resetBackgroundShells();
    const run = startBackgroundShell({ command: 'printf first; sleep 0.3; printf second', cwd: workspace, workspaceRoot: workspace });
    await until(() => (readBackgroundOutput(run.id)?.chunk ?? '').includes('first'));
    const r1 = readBackgroundOutput(run.id)!;
    assert.match(r1.chunk, /first/);
    await until(() => getBackgroundShell(run.id)?.status !== 'running');
    const r2 = readBackgroundOutput(run.id, r1.nextOffset)!;
    assert.match(r2.chunk, /second/);
    assert.ok(!r2.chunk.includes('first'), 'offset read returns only NEW output');
    assert.equal(r2.complete, true);
    assert.equal(readBackgroundOutput('bgsh_nope', 0), null);
  });
});

test('WS2/WS6 killBackgroundShell: terminates a long-running shell + is idempotent', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    __resetBackgroundShells();
    const run = startBackgroundShell({ command: 'sleep 30', cwd: workspace, workspaceRoot: workspace });
    assert.equal(run.status, 'running');
    assert.equal(killBackgroundShell(run.id), true, 'a running shell is killed');
    const after = getBackgroundShell(run.id)!;
    assert.notEqual(after.status, 'running', 'status flips off running immediately');
    assert.ok(after.endedAt, 'endedAt stamped');
    assert.equal(killBackgroundShell(run.id), false, 'idempotent: already-ended is a no-op');
    assert.equal(killBackgroundShell('bgsh_nope'), false, 'unknown id is a no-op');
    // the OS actually reaped it — the child `exit` handler runs
    await until(() => getBackgroundShell(run.id)?.status !== 'running');
  });
});

test('WS6 killAllBackgroundShells: stops every running shell (workflow Stop-all)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    __resetBackgroundShells();
    const a = startBackgroundShell({ command: 'sleep 30', cwd: workspace, workspaceRoot: workspace });
    const b = startBackgroundShell({ command: 'sleep 30', cwd: workspace, workspaceRoot: workspace });
    assert.equal(killAllBackgroundShells(), 2, 'both running shells signalled');
    assert.notEqual(getBackgroundShell(a.id)!.status, 'running');
    assert.notEqual(getBackgroundShell(b.id)!.status, 'running');
    assert.equal(killAllBackgroundShells(), 0, 'nothing left to kill');
  });
});

test('run_command background:true + task_output end-to-end through the executor', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    __resetBackgroundShells();
    const { Agent } = await import('../agent/agent.js');
    // Silent agents need the parent fast-mode opt-in for safe shell commands.
    const { writePreferences } = await import('../session/preferencesStore.js');
    writePreferences(workspace, { executionMode: 'fast' });
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    // Background runs are unsandboxed (v1), so they are refused while the
    // sandbox is active — including the unattended-enforcement default. This
    // test exercises the background capability itself, so opt out of enforcement
    // the way an operator would (cli.sandboxEnforceWhenSilent:false). Set it
    // synchronously right before construction — the Agent captures the knob in
    // its constructor, so a concurrent test cannot race the override away.
    setCliKnobOverride({ sandboxEnforceWhenSilent: false });
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: true, accessMode: 'shell',
    });
    const runTool = (name: string, args: any): Promise<string> =>
      (agent as any).executeLocalTool(name, args, [], new Map());

    const started = JSON.parse(await runTool('run_command', { command: 'echo bg-works', background: true }));
    assert.ok(started.id.startsWith('bgsh_'));
    assert.match(started.note, /task_output/);

    await until(() => getBackgroundShell(started.id)?.status !== 'running');
    const out = JSON.parse(await runTool('task_output', { id: started.id }));
    assert.match(out.chunk, /bg-works/);
    assert.equal(out.status, 'done');
    assert.equal(out.complete, true);

    const missing = JSON.parse(await runTool('task_output', { id: 'bgsh_missing' }));
    assert.equal(missing.found, false);
    _resetCliKnobsCache();
  });
});
