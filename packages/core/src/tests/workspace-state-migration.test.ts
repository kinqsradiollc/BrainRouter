/**
 * The legacy-state migration deletes everything under a workspace's
 * `.brainrouter/` that it does not recognise as workspace-local, on the theory
 * that the rest is stale runtime state already rescued into the real home.
 *
 * That theory is only safe if the preserved list is complete. `agents/` was
 * missing from it, so workspace-local orchestration ROLE definitions — files a
 * team writes deliberately and commits, the same category as `workflows/` — were
 * deleted the first time the runtime migrated. These tests pin the two halves:
 * the things that must survive, and the things that must still be swept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStateFile } from '../storage/store.js';

function withMigratingWorkspace(fn: (workspace: string) => void): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-migrate-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-migrate-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  // A home OUTSIDE the workspace is what arms the migration; when they are the
  // same tree it returns early and nothing is swept.
  process.env.BRAINROUTER_HOME = home;
  try {
    fn(fs.realpathSync(workspace));
  } finally {
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('the migration keeps workspace-local role definitions', () => {
  withMigratingWorkspace((workspace) => {
    const agents = path.join(workspace, '.brainrouter', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    const role = path.join(agents, 'reviewer.json');
    fs.writeFileSync(role, JSON.stringify({ schemaVersion: 1, id: 'reviewer' }), 'utf8');

    // Any state read triggers the migration through getWorkspaceStateRoot.
    getStateFile(workspace, 'hooks.json');

    assert.equal(
      fs.existsSync(role),
      true,
      'a committed role definition must survive the legacy-state migration',
    );
  });
});

test('the migration still keeps committable workflows and the manifest', () => {
  withMigratingWorkspace((workspace) => {
    const root = path.join(workspace, '.brainrouter');
    fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workflows', 'spec.md'), '# spec', 'utf8');
    fs.writeFileSync(path.join(root, 'workspace.json'), '{}', 'utf8');

    getStateFile(workspace, 'hooks.json');

    assert.equal(fs.existsSync(path.join(root, 'workflows', 'spec.md')), true);
    assert.equal(fs.existsSync(path.join(root, 'workspace.json')), true);
  });
});

test('the migration still sweeps genuinely stale runtime state', () => {
  // The preserved list must not become "preserve everything" — that would leave
  // the stale in-workspace state the sweep exists to remove.
  withMigratingWorkspace((workspace) => {
    const root = path.join(workspace, '.brainrouter');
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', 'old.json'), '{}', 'utf8');

    getStateFile(workspace, 'hooks.json');

    assert.equal(
      fs.existsSync(path.join(root, 'sessions')),
      false,
      'unrecognised runtime state is still swept out of the workspace tree',
    );
  });
});
