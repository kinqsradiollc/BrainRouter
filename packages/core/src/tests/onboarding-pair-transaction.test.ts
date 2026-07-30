import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspaceManifest,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  serializeWorkspaceManifest,
  workspaceManifestPath,
} from '../workspace/manifest.js';
import { writeWorkspaceFileAtomic } from '../workspace/fileWrite.js';
import {
  beginWorkspaceOnboardingPairTransaction,
  completeWorkspaceOnboardingPairTransaction,
  endWorkspaceOnboardingPairTransaction,
  markWorkspaceOnboardingInstructionCommitting,
  markWorkspaceOnboardingManifestCommitting,
  recordWorkspaceOnboardingInstructionStaged,
  recordWorkspaceOnboardingInstructionWritten,
  recordWorkspaceOnboardingManifestWritten,
  recoverInterruptedWorkspaceOnboardingPair,
  type WorkspaceOnboardingFileSnapshot,
  type WorkspaceOnboardingPairTransaction,
} from '../workspace/onboardingTransaction.js';

function snapshot(target: string): WorkspaceOnboardingFileSnapshot {
  try {
    const stat = fs.lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return {
      existed: true,
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      contents: fs.readFileSync(target),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
}

function fixture(): { workspace: string; home: string; previousHome: string | undefined } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-pair-workspace-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-pair-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  return { workspace, home, previousHome };
}

function cleanup(
  state: ReturnType<typeof fixture>,
  transaction?: WorkspaceOnboardingPairTransaction,
): void {
  if (transaction) endWorkspaceOnboardingPairTransaction(transaction);
  if (state.previousHome === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = state.previousHome;
  fs.rmSync(state.home, { recursive: true, force: true });
  fs.rmSync(state.workspace, { recursive: true, force: true });
}

test('pair recovery restores an instruction when the manifest was not committed', () => {
  const state = fixture();
  const instructionPath = path.join(state.workspace, 'AGENT.md');
  const originalManifest = createWorkspaceManifest({ name: 'before', profile: 'engineering', by: 'wizard' });
  const desiredManifest = createWorkspaceManifest({ name: 'after', profile: 'research', by: 'wizard' });
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  try {
    fs.writeFileSync(instructionPath, '# Before\n', { mode: 0o640 });
    saveWorkspaceManifest(state.workspace, originalManifest);
    transaction = beginWorkspaceOnboardingPairTransaction(state.workspace, {
      manifestBefore: snapshot(workspaceManifestPath(state.workspace)),
      manifestDesired: serializeWorkspaceManifest(desiredManifest),
      instructionBefore: snapshot(instructionPath),
      instructionDesired: '# After\n',
    });
    markWorkspaceOnboardingInstructionCommitting(transaction);
    writeWorkspaceFileAtomic(state.workspace, 'AGENT.md', '# After\n', {
      onStaged: (staged) => recordWorkspaceOnboardingInstructionStaged(transaction!, staged),
    });
    recordWorkspaceOnboardingInstructionWritten(transaction, 'created', snapshot(instructionPath));
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;

    assert.equal(loadWorkspaceManifest(state.workspace)?.name, 'before');
    assert.equal(fs.readFileSync(instructionPath, 'utf8'), '# Before\n');
    assert.equal(fs.statSync(instructionPath).mode & 0o777, 0o640);
    assert.equal(JSON.parse(fs.readFileSync(workspaceManifestPath(state.workspace), 'utf8')).name, 'before');
  } finally {
    cleanup(state, transaction);
  }
});

test('pair recovery accepts a fully written instruction and manifest', () => {
  const state = fixture();
  const instructionPath = path.join(state.workspace, 'AGENT.md');
  const desiredManifest = createWorkspaceManifest({ name: 'complete', profile: 'research', by: 'wizard' });
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  try {
    transaction = beginWorkspaceOnboardingPairTransaction(state.workspace, {
      manifestBefore: { existed: false },
      manifestDesired: serializeWorkspaceManifest(desiredManifest),
      instructionBefore: { existed: false },
      instructionDesired: '# Instructions\n',
    });
    markWorkspaceOnboardingInstructionCommitting(transaction);
    writeWorkspaceFileAtomic(state.workspace, 'AGENT.md', '# Instructions\n', {
      exclusive: true,
      onStaged: (staged) => recordWorkspaceOnboardingInstructionStaged(transaction!, staged),
    });
    recordWorkspaceOnboardingInstructionWritten(transaction, 'created', snapshot(instructionPath));
    markWorkspaceOnboardingManifestCommitting(transaction);
    saveWorkspaceManifest(state.workspace, desiredManifest, { exclusive: true });
    recordWorkspaceOnboardingManifestWritten(transaction, snapshot(workspaceManifestPath(state.workspace)));
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;

    recoverInterruptedWorkspaceOnboardingPair(state.workspace);
    assert.equal(fs.readFileSync(instructionPath, 'utf8'), '# Instructions\n');
    assert.equal(JSON.parse(fs.readFileSync(workspaceManifestPath(state.workspace), 'utf8')).name, 'complete');
  } finally {
    cleanup(state, transaction);
  }
});

test('pair recovery defers to an active owner and explicit completion cleans up', () => {
  const state = fixture();
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  try {
    const desiredManifest = createWorkspaceManifest({
      name: 'active',
      profile: 'research',
      by: 'wizard',
    });
    transaction = beginWorkspaceOnboardingPairTransaction(state.workspace, {
      manifestBefore: { existed: false },
      manifestDesired: serializeWorkspaceManifest(desiredManifest),
      instructionBefore: { existed: false },
      instructionDesired: '# Instructions\n',
    });

    recoverInterruptedWorkspaceOnboardingPair(state.workspace);
    assert.equal(fs.existsSync(transaction.receiptPath), true);

    completeWorkspaceOnboardingPairTransaction(transaction);
    assert.equal(fs.existsSync(transaction.receiptPath), false);
  } finally {
    cleanup(state, transaction);
  }
});

test('pair recovery preserves an ambiguous concurrent write for manual recovery', () => {
  const state = fixture();
  const instructionPath = path.join(state.workspace, 'AGENT.md');
  const originalManifest = createWorkspaceManifest({
    name: 'before',
    profile: 'engineering',
    by: 'wizard',
  });
  const desiredManifest = createWorkspaceManifest({
    name: 'after',
    profile: 'research',
    by: 'wizard',
  });
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  try {
    fs.writeFileSync(instructionPath, '# Before\n', { mode: 0o640 });
    saveWorkspaceManifest(state.workspace, originalManifest);
    transaction = beginWorkspaceOnboardingPairTransaction(state.workspace, {
      manifestBefore: snapshot(workspaceManifestPath(state.workspace)),
      manifestDesired: serializeWorkspaceManifest(desiredManifest),
      instructionBefore: snapshot(instructionPath),
      instructionDesired: '# After\n',
    });
    markWorkspaceOnboardingInstructionCommitting(transaction);
    writeWorkspaceFileAtomic(state.workspace, 'AGENT.md', '# After\n', {
      onStaged: (staged) =>
        recordWorkspaceOnboardingInstructionStaged(transaction!, staged),
    });
    recordWorkspaceOnboardingInstructionWritten(
      transaction,
      'created',
      snapshot(instructionPath),
    );
    const receiptPath = transaction.receiptPath;
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;
    fs.writeFileSync(instructionPath, '# Human concurrent change\n');

    recoverInterruptedWorkspaceOnboardingPair(state.workspace);

    assert.equal(
      fs.readFileSync(instructionPath, 'utf8'),
      '# Human concurrent change\n',
    );
    assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).phase, 'ambiguous');
    assert.equal(loadWorkspaceManifest(state.workspace)?.name, 'before');
  } finally {
    cleanup(state, transaction);
  }
});

test('pair recovery fails closed on an invalid receipt', () => {
  const state = fixture();
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  try {
    const desiredManifest = createWorkspaceManifest({ name: 'invalid', profile: 'research', by: 'wizard' });
    transaction = beginWorkspaceOnboardingPairTransaction(state.workspace, {
      manifestBefore: { existed: false },
      manifestDesired: serializeWorkspaceManifest(desiredManifest),
      instructionBefore: { existed: false },
      instructionDesired: '# Instructions\n',
    });
    assert.equal(fs.statSync(transaction.receiptPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(transaction.receiptPath)).mode & 0o777, 0o700);
    const receiptPath = transaction.receiptPath;
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;
    fs.writeFileSync(receiptPath, '{}\n');

    assert.throws(
      () => recoverInterruptedWorkspaceOnboardingPair(state.workspace),
      /Invalid workspace onboarding transaction receipt/,
    );
    assert.equal(fs.existsSync(receiptPath), true);
  } finally {
    cleanup(state, transaction);
  }
});

test('pair recovery rejects an accessible receipt directory', { skip: process.platform === 'win32' }, () => {
  const state = fixture();
  let transaction: WorkspaceOnboardingPairTransaction | undefined;
  try {
    const desiredManifest = createWorkspaceManifest({ name: 'unsafe-dir', profile: 'research', by: 'wizard' });
    transaction = beginWorkspaceOnboardingPairTransaction(state.workspace, {
      manifestBefore: { existed: false },
      manifestDesired: serializeWorkspaceManifest(desiredManifest),
      instructionBefore: { existed: false },
      instructionDesired: '# Instructions\n',
    });
    const receiptDirectory = path.dirname(transaction.receiptPath);
    endWorkspaceOnboardingPairTransaction(transaction);
    transaction = undefined;
    fs.chmodSync(receiptDirectory, 0o777);

    assert.throws(
      () => recoverInterruptedWorkspaceOnboardingPair(state.workspace),
      /Unsafe workspace onboarding transaction directory permissions/,
    );
  } finally {
    cleanup(state, transaction);
  }
});
