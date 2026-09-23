/**
 * ADR-052 P4.3 — the model-switch hook pair actually FIRES. `setModel` runs a
 * `pre-model-switch` hook (a deny blocks the change) and a `post-model-switch`
 * hook after a successful change. Same process-global discipline as the other
 * hook tests: serial() so temp workspaces don't clobber each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../agent/agent.js';
import { addHook } from '../hooks/hooksStore.js';
import { withTempWorkspaceAsync } from './_helpers.js';

let _gate: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = _gate.then(fn, fn);
  _gate = run.then(() => undefined, () => undefined);
  return run;
}
const stubMcp: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [{ text: '{}' }] }), close: async () => {} };

test('setModel changes the model when nothing denies, and no-ops on the same model', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    // A post hook that "passes" (exit 0) must not affect the change.
    addHook(workspace, { event: 'post-model-switch', command: `true` });
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'model-a' }, { workspaceRoot: workspace, launchCwd: workspace });
    agent.setModel('model-b');
    assert.equal(agent.getModel(), 'model-b', 'the switch went through');
    agent.setModel('model-b'); // identical → no-op, fires nothing
    assert.equal(agent.getModel(), 'model-b');
  }));
});

test('a pre-model-switch hook that denies blocks the switch', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    addHook(workspace, { event: 'pre-model-switch', command: `echo '{"decision":"deny","reason":"model pinned by policy"}'` });
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'model-a' }, { workspaceRoot: workspace, launchCwd: workspace });
    agent.setModel('model-b');
    assert.equal(agent.getModel(), 'model-a', 'the deny hook blocked the switch');
  }));
});

test('a pre-model-switch hook with a non-zero exit also blocks the switch', async () => {
  await serial(() => withTempWorkspaceAsync(async (workspace) => {
    addHook(workspace, { event: 'pre-model-switch', command: `exit 1` });
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'model-a' }, { workspaceRoot: workspace, launchCwd: workspace });
    agent.setModel('model-b');
    assert.equal(agent.getModel(), 'model-a');
  }));
});
