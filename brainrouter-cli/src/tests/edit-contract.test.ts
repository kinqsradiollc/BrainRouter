import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent/agent.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function agentFor(workspace: string): Agent {
  const stubMcp: any = {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ text: '{}' }] }),
    close: async () => {},
  };
  return new Agent(stubMcp, { provider: 'openai', apiKey: 'k', model: 'test-model' }, {
    workspaceRoot: workspace, launchCwd: workspace, silent: true, accessMode: 'write',
  });
}

// executeLocalTool is private; drive it through the test-only accessor the
// other agent tests use. Fall back to (agent as any) if not exposed.
async function runTool(agent: Agent, name: string, args: any): Promise<string> {
  return (agent as any).executeLocalTool(name, args, [], new Map());
}

test('CC-P6.4: edit_file is refused until the file has been read this session', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'hello world\n');
    const agent = agentFor(workspace);

    await assert.rejects(
      () => runTool(agent, 'edit_file', { path: 'a.txt', targetContent: 'hello', replacementContent: 'hi' }),
      /Read-before-edit/,
    );

    await runTool(agent, 'read_file', { path: 'a.txt' });
    const ok = await runTool(agent, 'edit_file', { path: 'a.txt', targetContent: 'hello', replacementContent: 'hi' });
    assert.match(ok, /Successfully edited/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hi world\n');
  });
});

test('CC-P6.4: edit_file still enforces unique match after a read', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'x x x\n');
    const agent = agentFor(workspace);
    await runTool(agent, 'read_file', { path: 'b.txt' });
    await assert.rejects(
      () => runTool(agent, 'edit_file', { path: 'b.txt', targetContent: 'x', replacementContent: 'y' }),
      /found 3 times/,
    );
  });
});

test('CC-P6.4: write_file creates a NEW file without a prior read', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = agentFor(workspace);
    const ok = await runTool(agent, 'write_file', { path: 'new.txt', content: 'fresh\n' });
    assert.match(ok, /Successfully wrote/);
    assert.equal(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'fresh\n');
  });
});

test('CC-P6.4: overwriting an EXISTING file requires a prior read', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    fs.writeFileSync(path.join(workspace, 'c.txt'), 'old\n');
    const agent = agentFor(workspace);
    await assert.rejects(
      () => runTool(agent, 'write_file', { path: 'c.txt', content: 'new\n' }),
      /Read-before-overwrite/,
    );
    await runTool(agent, 'read_file', { path: 'c.txt' });
    const ok = await runTool(agent, 'write_file', { path: 'c.txt', content: 'new\n' });
    assert.match(ok, /Successfully wrote/);
  });
});

test('CC-P6.4: a successful write makes the file editable (ledger stays accurate)', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const agent = agentFor(workspace);
    await runTool(agent, 'write_file', { path: 'd.txt', content: 'one two\n' });
    // No explicit read, but the write established what's on disk → edit allowed.
    const ok = await runTool(agent, 'edit_file', { path: 'd.txt', targetContent: 'one', replacementContent: '1' });
    assert.match(ok, /Successfully edited/);
  });
});
