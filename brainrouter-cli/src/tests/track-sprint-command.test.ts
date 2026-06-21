import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkItem, getWorkItem, listSprints, transitionWorkItem, updateWorkItem } from '@kinqs/brainrouter-core/dist/track/trackStore.js';
import { tryHandleTrackCommand } from '../cli/commands/track.js';

function context(workspaceRoot: string, args: string[]): any {
  return {
    command: '/track',
    args,
    agent: { workspaceRoot, sessionKey: 'session:test' },
  };
}

async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('/track sprint drives the shared sprint lifecycle', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-track-sprint-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-track-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const item = createWorkItem(workspace, { title: 'Five-point task' });
    updateWorkItem(workspace, item.key, { storyPoints: 5 });
    transitionWorkItem(workspace, item.key, 'done');

    const created = await captureLogs(() => tryHandleTrackCommand(context(workspace, ['sprint', 'create', 'Sprint 1'])));
    assert.match(created, /created.*sprint 1/i);
    const sprint = listSprints(workspace)[0];

    const started = await captureLogs(() => tryHandleTrackCommand(context(workspace, ['sprint', 'start', sprint.id, '--capacity', '8'])));
    assert.match(started, /started.*sprint 1/i);
    assert.equal(listSprints(workspace)[0].state, 'active');
    assert.equal(listSprints(workspace)[0].capacity, 8);

    const assigned = await captureLogs(() => tryHandleTrackCommand(context(workspace, ['sprint', 'assign', item.key, sprint.id])));
    assert.match(assigned, /assigned/i);
    assert.equal(getWorkItem(workspace, item.key)!.sprintId, sprint.id);

    const completed = await captureLogs(() => tryHandleTrackCommand(context(workspace, ['sprint', 'complete', sprint.id])));
    assert.match(completed, /completed.*velocity.*5/i);
    assert.equal(listSprints(workspace)[0].velocity, 5);

    const velocity = await captureLogs(() => tryHandleTrackCommand(context(workspace, ['sprint', 'velocity', sprint.id])));
    assert.match(velocity, /velocity.*5/i);
  } finally {
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
