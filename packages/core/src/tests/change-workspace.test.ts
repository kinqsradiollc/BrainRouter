import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeAgent, withTempWorkspace } from './_helpers.js';

// CC-UX-E1 — /cd: Agent.changeWorkspace moves the session working directory
// without dropping the transcript/memory (sessionKey is untouched), and resets
// the read-ledger + child/worktree carry-over.

test('changeWorkspace: moves the workspace root and keeps the session identity', () => {
  withTempWorkspace((ws) => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-cd-'));
    try {
      const agent = makeAgent(ws);
      const sessionBefore = agent.sessionKey;
      // Seed state that must be reset on a move.
      agent.filesReadThisSession.add(path.join(ws, 'a.ts'));
      agent.lastTurnPendingChildIds = ['child-1'];

      const resolved = agent.changeWorkspace(dest);

      assert.equal(resolved, fs.realpathSync(dest));
      assert.equal(agent.workspaceRoot, fs.realpathSync(dest));
      // Session identity (→ transcript + memory bucket) is preserved.
      assert.equal(agent.sessionKey, sessionBefore);
      // Read-ledger + child carry-over reset (old-root paths are invalid now).
      assert.equal(agent.filesReadThisSession.size, 0);
      assert.deepEqual(agent.lastTurnPendingChildIds, []);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

test('changeWorkspace: resolves a relative path against the current root', () => {
  withTempWorkspace((ws) => {
    const sub = path.join(ws, 'sub');
    fs.mkdirSync(sub);
    const agent = makeAgent(ws);
    const resolved = agent.changeWorkspace('sub');
    assert.equal(resolved, fs.realpathSync(sub));
  });
});

test('changeWorkspace: a no-op move to the same (canonical) root keeps state', () => {
  withTempWorkspace((ws) => {
    // Anchor the agent at the canonical path so a same-root move is a true
    // no-op (mkdtemp on macOS returns /var/... which realpaths to /private/var).
    const canonical = fs.realpathSync(ws);
    const agent = makeAgent(canonical);
    agent.filesReadThisSession.add(path.join(canonical, 'keep.ts'));
    const resolved = agent.changeWorkspace(canonical);
    assert.equal(resolved, agent.workspaceRoot);
    // Same-root move must NOT wipe the read ledger.
    assert.equal(agent.filesReadThisSession.size, 1);
  });
});

test('changeWorkspace: throws on a missing path and on a file (not a directory)', () => {
  withTempWorkspace((ws) => {
    const agent = makeAgent(ws);
    const rootBefore = agent.workspaceRoot;
    assert.throws(() => agent.changeWorkspace(path.join(ws, 'does-not-exist')), /does not exist/i);
    const file = path.join(ws, 'file.txt');
    fs.writeFileSync(file, 'x');
    assert.throws(() => agent.changeWorkspace(file), /not a directory/i);
    // A failed move leaves the session pointed at the old root.
    assert.equal(agent.workspaceRoot, rootBefore);
  });
});

test('changeWorkspace: empty input is rejected', () => {
  withTempWorkspace((ws) => {
    const agent = makeAgent(ws);
    assert.throws(() => agent.changeWorkspace('   '), /required/i);
  });
});
