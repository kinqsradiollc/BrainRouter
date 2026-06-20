import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Agent } from '../agent/agent.js';
import { checkWaitCondition, waitUntilCondition } from '../util/waitUntil.js';
import { withTempWorkspaceAsync } from './_helpers.js';

test('checkWaitCondition: exists + contains + missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wait-'));
  try {
    const f = path.join(dir, 'log.txt');
    assert.equal(checkWaitCondition('file_exists', f), false);
    fs.writeFileSync(f, 'building...\n');
    assert.equal(checkWaitCondition('file_exists', f), true);
    assert.equal(checkWaitCondition('file_contains', f, 'DONE'), false);
    fs.appendFileSync(f, 'DONE\n');
    assert.equal(checkWaitCondition('file_contains', f, 'DONE'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitUntilCondition: resolves when the file appears mid-wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-wait2-'));
  try {
    const f = path.join(dir, 'artifact.bin');
    setTimeout(() => fs.writeFileSync(f, 'x'), 150);
    const r = await waitUntilCondition({ condition: 'file_exists', resolvedPath: f, timeoutMs: 3000, pollMs: 50 });
    assert.equal(r.satisfied, true);
    assert.ok(r.waitedMs >= 100 && r.waitedMs < 3000, `waited ${r.waitedMs}ms`);
    assert.ok(r.checks >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waitUntilCondition: times out unsatisfied (never rejects)', async () => {
  const r = await waitUntilCondition({ condition: 'file_exists', resolvedPath: '/nonexistent/never.txt', timeoutMs: 200, pollMs: 50 });
  assert.equal(r.satisfied, false);
  assert.ok(r.waitedMs >= 200);
});

test('wait_until tool: arg validation + end-to-end through the executor', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };
    const agent = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
      workspaceRoot: workspace, launchCwd: workspace, silent: true,
    });
    const runTool = (name: string, args: any): Promise<string> =>
      (agent as any).executeLocalTool(name, args, [], new Map());

    await assert.rejects(() => runTool('wait_until', { condition: 'nope', path: 'x' }), /file_exists/);
    await assert.rejects(() => runTool('wait_until', { condition: 'file_contains', path: 'x' }), /requires `text`/);

    fs.writeFileSync(path.join(workspace, 'out.log'), 'status: DONE\n');
    const ok = JSON.parse(await runTool('wait_until', { condition: 'file_contains', path: 'out.log', text: 'DONE', timeoutMs: 1000 }));
    assert.equal(ok.satisfied, true);

    const miss = JSON.parse(await runTool('wait_until', { condition: 'file_exists', path: 'never.txt', timeoutMs: 150, pollMs: 50 }));
    assert.equal(miss.satisfied, false);
  });
});
