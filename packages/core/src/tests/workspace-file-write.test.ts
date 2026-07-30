import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _setWorkspaceFileAccessHookForTests,
  readWorkspaceFileBounded,
  writeWorkspaceFileAtomic,
} from '../workspace/fileWrite.js';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-workspace-file-'));
}

test('workspace reads and writes reject a parent-directory symlink swap', { skip: process.platform === 'win32' }, () => {
  const workspace = tmpWorkspace();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-workspace-file-external-'));
  const parent = path.join(workspace, '.brainrouter');
  const displaced = path.join(workspace, '.brainrouter-displaced');
  const relativePath = path.join('.brainrouter', 'workspace.json');
  try {
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'workspace.json'), 'original');
    fs.writeFileSync(path.join(external, 'workspace.json'), 'external');

    assert.throws(() => readWorkspaceFileBounded(workspace, relativePath, 1024, {
      beforeOpen: () => {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(external, parent);
      },
    }), /Workspace directory changed during access/);
    assert.equal(fs.readFileSync(path.join(external, 'workspace.json'), 'utf8'), 'external');

    fs.rmSync(parent);
    fs.renameSync(displaced, parent);
    assert.throws(() => writeWorkspaceFileAtomic(workspace, relativePath, 'replacement', {
      beforeCommit: () => {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(external, parent);
      },
    }), /Workspace directory changed during access/);
    assert.equal(fs.readFileSync(path.join(external, 'workspace.json'), 'utf8'), 'external');
    assert.equal(fs.readFileSync(path.join(displaced, 'workspace.json'), 'utf8'), 'original');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('workspace writes reject a workspace-root swap before creating parents', { skip: process.platform === 'win32' }, () => {
  const workspace = tmpWorkspace();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-workspace-root-external-'));
  const displaced = `${workspace}-displaced`;
  try {
    _setWorkspaceFileAccessHookForTests(() => {
      fs.renameSync(workspace, displaced);
      fs.symlinkSync(external, workspace);
      _setWorkspaceFileAccessHookForTests(undefined);
    });

    assert.throws(
      () => writeWorkspaceFileAtomic(workspace, '.brainrouter/workspace.json', '{}\n'),
      /Workspace directory changed during access/,
    );
    assert.equal(fs.existsSync(path.join(external, '.brainrouter')), false);
    assert.equal(fs.existsSync(path.join(displaced, '.brainrouter')), false);
  } finally {
    _setWorkspaceFileAccessHookForTests(undefined);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(displaced, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('workspace paths reject traversal and drive-relative prefixes', () => {
  const workspace = tmpWorkspace();
  try {
    for (const relativePath of ['../outside.txt', 'C:outside.txt']) {
      assert.throws(
        () => writeWorkspaceFileAtomic(workspace, relativePath, 'blocked'),
        /Unsafe workspace-relative path/,
      );
      assert.equal(fs.existsSync(path.join(workspace, relativePath)), false);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspace file access rejects symlink targets without touching external files', { skip: process.platform === 'win32' }, () => {
  const workspace = tmpWorkspace();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-workspace-target-external-'));
  try {
    const externalTarget = path.join(external, 'workspace.json');
    fs.writeFileSync(externalTarget, 'external');
    fs.mkdirSync(path.join(workspace, '.brainrouter'));
    fs.symlinkSync(externalTarget, path.join(workspace, '.brainrouter', 'workspace.json'));

    assert.throws(
      () => readWorkspaceFileBounded(workspace, '.brainrouter/workspace.json', 1024),
      /Unsafe workspace file/,
    );
    assert.throws(
      () => writeWorkspaceFileAtomic(workspace, '.brainrouter/workspace.json', 'replacement'),
      /Unsafe workspace file/,
    );
    assert.equal(fs.readFileSync(externalTarget, 'utf8'), 'external');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
