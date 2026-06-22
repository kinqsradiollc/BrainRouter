import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceService, WorkspaceService } from '../workspace/service.js';
import { findWorkspaceRoot } from '../workspace/workspace.js';
import { isWorkspaceTrusted, listTrustedWorkspaces } from '../workspace/workspaceTrust.js';

test('WorkspaceService is a stateless facade — delegates to workspace resolution + trust', () => {
  const svc = createWorkspaceService();
  assert.ok(svc instanceof WorkspaceService);

  // Read-only delegation only — trust/untrust/applyRoot have global/process side
  // effects and delegate by construction.
  assert.deepEqual(svc.findRoot(process.cwd()), findWorkspaceRoot(process.cwd()));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-svc-'));
  try {
    assert.equal(svc.isTrusted(tmp), isWorkspaceTrusted(tmp));
    assert.deepEqual(svc.listTrusted(), listTrustedWorkspaces());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
