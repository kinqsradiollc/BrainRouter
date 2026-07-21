/**
 * ADR-021 W2b (0.4.17) — deterministic concurrency guards for manifest-claim recovery.
 *
 * Recovery is deliberately lock-free, so competing recoverers must converge on
 * the exact claimed inode while preserving any different concurrent creator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginWorkspaceManifestClaim,
  endWorkspaceManifestClaim,
  recoverInterruptedWorkspaceManifestClaim,
  type WorkspaceManifestClaimExpected,
} from '../workspace/manifestClaim.js';

function expectedVersion(target: string): WorkspaceManifestClaimExpected {
  const stat = fs.statSync(target);
  return {
    mode: stat.mode & 0o777,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contents: fs.readFileSync(target),
  };
}

function withInterruptedClaim(
  run: (state: { workspace: string; target: string; claim: string; receiptPath: string }) => void,
): void {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-manifest-claim-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-manifest-claim-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const directory = path.join(workspace, '.brainrouter');
    const target = path.join(directory, 'workspace.json');
    fs.mkdirSync(directory);
    fs.writeFileSync(target, '{"profile":"engineering"}\n', { mode: 0o640 });
    const transaction = beginWorkspaceManifestClaim(
      workspace,
      target,
      expectedVersion(target),
      { desired: '{"profile":"research"}\n' },
    );
    fs.renameSync(target, transaction.claim);
    endWorkspaceManifestClaim(transaction);
    run({
      workspace,
      target,
      claim: transaction.claim,
      receiptPath: transaction.receiptPath,
    });
  } finally {
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('ADR-021 manifest recovery converges when another recoverer wins link and cleanup races', () => {
  withInterruptedClaim(({ workspace, target, claim, receiptPath }) => {
    const originalLink = fs.linkSync;
    const originalOpen = fs.openSync;
    const originalUnlink = fs.unlinkSync;
    let racedLink = false;
    let targetOpensAfterRace = 0;
    let claimRemovedBetweenSnapshots = false;
    const racedUnlinks = new Set<string>();
    fs.linkSync = ((existingPath, newPath) => {
      if (!racedLink && existingPath === claim && newPath === target) {
        racedLink = true;
        originalLink(existingPath, newPath);
      }
      originalLink(existingPath, newPath);
    }) as typeof fs.linkSync;
    fs.openSync = ((candidate, flags, mode) => {
      if (racedLink && candidate === target) {
        targetOpensAfterRace += 1;
        if (targetOpensAfterRace === 2) {
          originalUnlink(claim);
          claimRemovedBetweenSnapshots = true;
        }
      }
      return originalOpen(candidate, flags, mode);
    }) as typeof fs.openSync;
    fs.unlinkSync = ((candidate) => {
      const candidatePath = candidate.toString();
      if ((candidatePath === claim || candidatePath === receiptPath) && !racedUnlinks.has(candidatePath)) {
        racedUnlinks.add(candidatePath);
        originalUnlink(candidate);
      }
      originalUnlink(candidate);
    }) as typeof fs.unlinkSync;
    try {
      recoverInterruptedWorkspaceManifestClaim(workspace);
    } finally {
      fs.linkSync = originalLink;
      fs.openSync = originalOpen;
      fs.unlinkSync = originalUnlink;
    }

    assert.equal(racedLink, true, 'the test must force the EEXIST recovery branch');
    assert.equal(
      claimRemovedBetweenSnapshots,
      true,
      'the competing recoverer must unlink the claim between post-link snapshots',
    );
    assert.deepEqual(
      racedUnlinks,
      new Set([claim, receiptPath]),
      'the test must force ENOENT for both idempotent cleanup paths',
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '{"profile":"engineering"}\n');
    assert.equal(fs.existsSync(claim), false, 'the redundant claim is retired');
    assert.equal(fs.existsSync(receiptPath), false, 'the redundant receipt is retired');
  });
});

test('ADR-021 manifest recovery preserves a different creator that wins the link race', () => {
  withInterruptedClaim(({ workspace, target, claim, receiptPath }) => {
    const originalLink = fs.linkSync;
    let racedLink = false;
    fs.linkSync = ((existingPath, newPath) => {
      if (!racedLink && existingPath === claim && newPath === target) {
        racedLink = true;
        fs.writeFileSync(target, '{"profile":"writing"}\n');
      }
      originalLink(existingPath, newPath);
    }) as typeof fs.linkSync;
    try {
      recoverInterruptedWorkspaceManifestClaim(workspace);
    } finally {
      fs.linkSync = originalLink;
    }

    assert.equal(racedLink, true, 'the test must force the EEXIST collision branch');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"profile":"writing"}\n');
    assert.equal(fs.existsSync(claim), true, 'the owned pre-state stays available for manual recovery');
    assert.equal(fs.existsSync(receiptPath), true, 'ambiguous ownership evidence is preserved');
    assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).phase, 'ambiguous');
  });
});
