/**
 * Workspace-onboarding receipt store fixtures.
 *
 * A25-5c: proves bounded durable writes, validated round trips, idempotent
 * cleanup, and injected local/remote owner-liveness decisions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RECEIPT_MAX_BYTES,
  type WorkspaceOnboardingPairReceipt,
} from '../workspace/onboardingTransaction/contracts.js';
import {
  prepareWorkspaceOnboardingReceiptPath,
  readWorkspaceOnboardingReceipt,
  removeWorkspaceOnboardingReceipt,
  workspaceOnboardingTransactionOwnerIsActive,
  writeWorkspaceOnboardingReceipt,
} from '../workspace/onboardingTransaction/receiptStore.js';

function receipt(
  workspaceRoot: string,
  token: string,
): WorkspaceOnboardingPairReceipt {
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    version: 1,
    phase: 'prepared',
    workspaceRoot,
    token,
    instruction: {
      before: { existed: false },
      desired: { size: 0, sha256: emptyHash },
    },
    manifest: {
      before: { existed: false },
      desired: { size: 0, sha256: emptyHash },
    },
  };
}

test('receipt writes are bounded, validated, and removed idempotently', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'br-receipt-workspace-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'br-receipt-home-'));
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;
  try {
    const token = `${process.pid}.${'a'.repeat(24)}`;
    const receiptPath = prepareWorkspaceOnboardingReceiptPath(workspace, token);
    const value = receipt(workspace, token);
    writeWorkspaceOnboardingReceipt(receiptPath, value, true);

    assert.deepEqual(
      readWorkspaceOnboardingReceipt(receiptPath, workspace, `${token}.json`),
      value,
    );
    assert.throws(
      () => writeWorkspaceOnboardingReceipt(
        receiptPath,
        {
          ...value,
          padding: 'x'.repeat(RECEIPT_MAX_BYTES),
        } as WorkspaceOnboardingPairReceipt,
      ),
      /receipt exceeds/,
    );

    removeWorkspaceOnboardingReceipt(receiptPath);
    removeWorkspaceOnboardingReceipt(receiptPath);
    assert.equal(fs.existsSync(receiptPath), false);
  } finally {
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('owner liveness distinguishes local tokens from remote processes', () => {
  const local = `${process.pid}.${'b'.repeat(24)}`;
  assert.equal(
    workspaceOnboardingTransactionOwnerIsActive(local, () => true, () => false),
    true,
  );
  assert.equal(
    workspaceOnboardingTransactionOwnerIsActive(local, () => false, () => true),
    false,
  );
  assert.equal(
    workspaceOnboardingTransactionOwnerIsActive(
      `424242.${'c'.repeat(24)}`,
      () => false,
      (pid) => pid === 424242,
    ),
    true,
  );
  assert.equal(
    workspaceOnboardingTransactionOwnerIsActive(
      `424243.${'d'.repeat(24)}`,
      () => true,
      () => false,
    ),
    false,
  );
});
