/**
 * ADR-042 S1 — WorkspaceScope + multi-root resolveWorkspacePathInScope.
 *
 * A session's workspace is a SET of attached roots (the primary + explicitly
 * entered same-repo worktrees). A path resolves when it is inside ANY root; the
 * DEEPEST matching root wins (E14). Everything outside every root keeps the
 * verbatim single-root escape message. Single-root scope === the pre-ADR-042
 * behavior, so these tests pin both the widening and the unchanged floor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWorkspacePath,
  resolveWorkspacePathInScope,
  singleRootScope,
  type WorkspaceScope,
} from '../agent/fs/workspaceFs.js';

function mkroot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('single-root scope is byte-identical to resolveWorkspacePath', () => {
  const ws = mkroot('adr042-single-');
  try {
    const scope = singleRootScope(ws);
    assert.equal(
      resolveWorkspacePathInScope(scope, 'src/a.ts'),
      resolveWorkspacePath(ws, 'src/a.ts'),
    );
    // Escape message identical for an unattached path.
    assert.throws(
      () => resolveWorkspacePathInScope(scope, '../outside.ts'),
      /^Error: Path escapes workspace root: \.\.\/outside\.ts$/,
    );
    assert.throws(
      () => resolveWorkspacePath(ws, '../outside.ts'),
      /^Error: Path escapes workspace root: \.\.\/outside\.ts$/,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('an attached root is resolvable; an unattached sibling still escapes', () => {
  const primary = mkroot('adr042-primary-');
  const attached = mkroot('adr042-attached-');
  const stranger = mkroot('adr042-stranger-');
  try {
    const scope: WorkspaceScope = { primaryRoot: primary, attachedRoots: [attached] };
    // A file addressed by ABSOLUTE path inside the attached root resolves.
    const target = path.join(attached, 'pkg', 'x.ts');
    assert.equal(resolveWorkspacePathInScope(scope, target), target);
    // A file inside a NON-attached root is rejected with the verbatim message.
    const outside = path.join(stranger, 'x.ts');
    assert.throws(
      () => resolveWorkspacePathInScope(scope, outside),
      new RegExp(`^Error: Path escapes workspace root: ${outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    );
    // Relative paths still anchor to the PRIMARY root, not the attached one.
    assert.equal(resolveWorkspacePathInScope(scope, 'r.ts'), path.join(primary, 'r.ts'));
  } finally {
    for (const d of [primary, attached, stranger]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the deepest matching root wins when one root nests inside another (E14)', () => {
  const outer = mkroot('adr042-outer-');
  const inner = fs.realpathSync((() => { const p = path.join(outer, 'nested'); fs.mkdirSync(p); return p; })());
  try {
    // Both roots contain `inner/f.ts`; the scope attaches the nested root too.
    const scope: WorkspaceScope = { primaryRoot: outer, attachedRoots: [inner] };
    const target = path.join(inner, 'f.ts');
    // Resolves (inside both) — and the return is the same absolute path either way.
    assert.equal(resolveWorkspacePathInScope(scope, target), target);
    // A path under outer but NOT under inner still resolves via the outer root.
    const outerOnly = path.join(outer, 'top.ts');
    assert.equal(resolveWorkspacePathInScope(scope, outerOnly), outerOnly);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('the symlink write-guard runs per-root: escape via symlink is rejected across all roots', { skip: process.platform === 'win32' }, () => {
  const primary = mkroot('adr042-slp-');
  const attached = mkroot('adr042-sla-');
  const secret = mkroot('adr042-secret-');
  try {
    const scope: WorkspaceScope = { primaryRoot: primary, attachedRoots: [attached] };
    // A symlink in the ATTACHED root pointing OUTSIDE every root — write rejected.
    const evil = path.join(attached, 'evil');
    fs.symlinkSync(path.join(secret, 'target'), evil);
    assert.throws(
      () => resolveWorkspacePathInScope(scope, evil, { forWrite: true }),
      /escapes workspace root via symlink/,
    );
    // A symlink in the attached root pointing INTO the primary root is allowed
    // (in-scope), because the scope is one trust domain.
    const cross = path.join(attached, 'cross');
    fs.symlinkSync(path.join(primary, 'ok.txt'), cross);
    assert.equal(resolveWorkspacePathInScope(scope, cross, { forWrite: true }), cross);
  } finally {
    for (const d of [primary, attached, secret]) fs.rmSync(d, { recursive: true, force: true });
  }
});
