/**
 * ADR-034 durable hold regressions: concurrent hosts preserve every decision,
 * terminal replay, fixed capacity, expiry, and safe-boundary acknowledgement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  __setHeldSessionMessageWriteHooksForTests,
  admitSessionMessage,
  approveHeldSessionMessage,
  declineHeldSessionMessage,
  expireHeldSessionMessages,
  HELD_SESSION_MESSAGE_MAX_RECORDS,
  holdSessionMessage,
  listHeldSessionMessages,
  markHeldSessionMessageApplied,
  rejectHeldSessionMessage,
} from '../session/input/heldSessionMessages.js';
import type { LocalSessionMessage } from '../session/messaging/contracts.js';
import { getStateFile, writeJsonFile } from '../storage/store.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function message(id: string, receivedAt = 1_000): LocalSessionMessage {
  return {
    id,
    senderSessionKey: 'sender:1',
    senderDeviceId: 'device:1',
    targetSessionKey: 'recipient:1',
    text: 'Check the failed build before merging.',
    source: 'peer-session',
    trust: 'untrusted-session',
    createdAt: receivedAt - 10,
    receivedAt,
  };
}

const unsafeAuthority = {
  workspaceFiles: 'allow' as const,
  shell: 'allow' as const,
  computerUse: 'unknown' as const,
  externalWrites: 'confirm' as const,
  remoteTools: 'confirm' as const,
};

test('durable hold history refuses new unique work at its 1,000-record bound', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    assert.equal(HELD_SESSION_MESSAGE_MAX_RECORDS, 1_000);
    const records = Array.from({ length: HELD_SESSION_MESSAGE_MAX_RECORDS }, (_, index) => ({
      ...message(`terminal-${index}`),
      status: 'rejected' as const,
      expiresAt: 86_401_000,
      holdReason: 'fixture terminal decision',
      decidedAt: 2_000,
    }));
    writeJsonFile(getStateFile(workspace, 'heldSessionMessages.json'), {
      schemaVersion: 1,
      records,
    });
    assert.throws(
      () => admitSessionMessage(workspace, message('over-capacity'), unsafeAuthority, 3_000),
      /queue is full.*maximum 1000/i,
    );
    assert.equal(listHeldSessionMessages(workspace, 'recipient:1', { now: 3_000 }).length,
      HELD_SESSION_MESSAGE_MAX_RECORDS);
  });
});

test('unsafe inbound messages persist through approve, replay, and applied acknowledgement', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const admitted = admitSessionMessage(workspace, message('m1'), unsafeAuthority, 1_000, {
      clientKind: 'desktop',
      title: 'Release verifier',
      workspaceRoot: '/workspace/release',
      transport: 'remote',
    });
    assert.equal(admitted.decision, 'held');
    assert.equal(listHeldSessionMessages(workspace, 'recipient:1', { status: 'held', now: 1_001 }).length, 1);

    const approved = approveHeldSessionMessage(workspace, 'recipient:1', 'm1', 1_002);
    assert.equal(approved.record.status, 'approved');
    assert.equal(approved.input?.source, 'peer-session');
    assert.equal(approved.input?.sender.sessionKey, 'sender:1');
    assert.equal(approved.input?.sender.clientKind, 'desktop');
    assert.equal(approved.input?.sender.title, 'Release verifier');
    assert.equal(approved.input?.sender.workspaceRoot, '/workspace/release');
    assert.equal(approved.input?.sender.transport, 'remote');
    assert.ok(approveHeldSessionMessage(workspace, 'recipient:1', 'm1', 1_003).input, 'unapplied approval replays');
    const replay = admitSessionMessage(workspace, message('m1'), unsafeAuthority, 1_003);
    assert.equal(replay.decision, 'apply', 'approved-but-unapplied rows requeue without another prompt');
    assert.equal(replay.decision === 'apply' ? replay.input.sender.title : '', 'Release verifier');

    markHeldSessionMessageApplied(workspace, 'recipient:1', 'm1', 1_004);
    assert.equal(approveHeldSessionMessage(workspace, 'recipient:1', 'm1', 1_005).input, undefined);
    assert.equal(
      admitSessionMessage(workspace, message('m1'), unsafeAuthority, 1_006).decision,
      'applied',
      'an applied row reports the lost-ack terminal state instead of reapplying',
    );
  });
});

test('held messages reject durably and expire after 24 hours', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    admitSessionMessage(workspace, message('reject'), unsafeAuthority, 1_000);
    assert.equal(rejectHeldSessionMessage(workspace, 'recipient:1', 'reject', 1_100).status, 'rejected');
    assert.equal(
      admitSessionMessage(workspace, message('reject'), unsafeAuthority, 1_101).decision,
      'rejected',
      'a rejected replay stays terminal and cannot prompt again',
    );

    admitSessionMessage(workspace, message('expire'), unsafeAuthority, 2_000);
    const expired = expireHeldSessionMessages(workspace, 2_000 + 24 * 60 * 60 * 1_000);
    assert.deepEqual(expired.map((record) => record.id), ['expire']);
    const delayedApproval = approveHeldSessionMessage(
      workspace,
      'recipient:1',
      'expire',
      2_000 + 24 * 60 * 60 * 1_000,
    );
    assert.equal(delayedApproval.record.status, 'expired');
    assert.equal(delayedApproval.input, undefined);
  });
});

test('a delayed terminal decision reports expiry instead of overwriting it', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const receivedAt = 1_000;
    admitSessionMessage(workspace, message('delayed-decision', receivedAt), unsafeAuthority, receivedAt);
    const cutoff = receivedAt + 24 * 60 * 60 * 1_000;

    const declined = declineHeldSessionMessage(
      workspace,
      'recipient:1',
      'delayed-decision',
      cutoff,
    );
    assert.equal(declined.status, 'expired');
    assert.equal(declined.terminalReceiptStatus, undefined);

    const rejectedReplay = rejectHeldSessionMessage(
      workspace,
      'recipient:1',
      'delayed-decision',
      cutoff + 1,
    );
    assert.equal(rejectedReplay.status, 'expired');
    assert.equal(rejectedReplay.terminalReceiptStatus, undefined);
  });
});

test('a delayed approval returns the authoritative expired record without requeueing', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const receivedAt = 5_000;
    admitSessionMessage(workspace, message('delayed-approval', receivedAt), unsafeAuthority, receivedAt);
    const approved = approveHeldSessionMessage(
      workspace,
      'recipient:1',
      'delayed-approval',
      receivedAt + 24 * 60 * 60 * 1_000,
    );
    assert.equal(approved.record.status, 'expired');
    assert.equal(approved.input, undefined);
    assert.equal(
      listHeldSessionMessages(workspace, 'recipient:1', { now: receivedAt + 24 * 60 * 60 * 1_000 })[0]?.status,
      'expired',
    );
  });
});

test('a delayed remote row keeps its database deadline through hold and approval', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const createdAt = 1_000;
    const expiresAt = createdAt + 24 * 60 * 60 * 1_000;
    const remote = {
      ...message('remote-absolute-expiry', expiresAt - 5),
      createdAt,
      expiresAt,
    };
    assert.equal(
      admitSessionMessage(workspace, remote, unsafeAuthority, expiresAt - 5).decision,
      'held',
    );
    assert.ok(
      approveHeldSessionMessage(
        workspace,
        remote.targetSessionKey,
        remote.id,
        expiresAt - 1,
      ).input,
    );
    const atDeadline = approveHeldSessionMessage(
      workspace,
      remote.targetSessionKey,
      remote.id,
      expiresAt,
    );
    assert.equal(atDeadline.record.status, 'expired');
    assert.equal(atDeadline.input, undefined);
  });
});

test('an already-expired message never auto-applies under a safe authority tuple', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const safeAuthority = {
      workspaceFiles: 'denied' as const,
      shell: 'confirm' as const,
      computerUse: 'denied' as const,
      externalWrites: 'confirm' as const,
      remoteTools: 'confirm' as const,
    };
    const admission = admitSessionMessage(
      workspace,
      message('old', 1_000),
      safeAuthority,
      1_000 + 24 * 60 * 60 * 1_000,
    );
    assert.equal(admission.decision, 'expired');
  });
});

test('an approved but unapplied message still expires, and terminal records are retained for seven days', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const startedAt = 5_000;
    admitSessionMessage(workspace, message('approved-expiry', startedAt), unsafeAuthority, startedAt);
    approveHeldSessionMessage(workspace, 'recipient:1', 'approved-expiry', startedAt + 1);

    const expiry = startedAt + 24 * 60 * 60 * 1_000;
    assert.deepEqual(
      expireHeldSessionMessages(workspace, expiry).map((record) => record.id),
      ['approved-expiry'],
    );
    assert.equal(listHeldSessionMessages(workspace, 'recipient:1', { now: expiry + 7 * 24 * 60 * 60 * 1_000 - 1 }).length, 1);
    assert.equal(listHeldSessionMessages(workspace, 'recipient:1', { now: expiry + 7 * 24 * 60 * 60 * 1_000 }).length, 0);
  });
});

test('held-message idempotency keys reject changed content', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    admitSessionMessage(workspace, message('conflict'), unsafeAuthority, 1_000);
    assert.throws(
      () => admitSessionMessage(
        workspace,
        { ...message('conflict'), text: 'A different instruction.' },
        unsafeAuthority,
        1_001,
      ),
      /reused with different content/i,
    );
  });
});

test('concurrent host processes cannot lose held-message read-modify-write updates', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const workerCount = 8;
    const messagesPerWorker = 8;
    const moduleUrl = new URL('../session/input/heldSessionMessages.js', import.meta.url).href;
    const tsxLoaderUrl = import.meta.resolve('tsx');
    const workers = Array.from({ length: workerCount }, (_, worker) => {
      const script = `
        import { holdSessionMessage } from ${JSON.stringify(moduleUrl)};
        const workspace = process.argv[1];
        const worker = Number(process.argv[2]);
        const count = Number(process.argv[3]);
        for (let index = 0; index < count; index++) {
          const id = \`worker-\${worker}-message-\${index}\`;
          holdSessionMessage(workspace, {
            id,
            senderSessionKey: \`sender-\${worker}\`,
            senderDeviceId: '11111111-1111-4111-8111-111111111111',
            targetSessionKey: 'concurrent-recipient',
            text: id,
            source: 'peer-session',
            trust: 'untrusted-session',
            createdAt: 1_000 + index,
            receivedAt: 2_000 + index,
          }, 'concurrency regression', 2_000 + index);
        }
      `;
      return childExit(process.execPath, [
        '--import',
        tsxLoaderUrl,
        '--input-type=module',
        '--eval',
        script,
        workspace,
        String(worker),
        String(messagesPerWorker),
      ]);
    });
    await Promise.all(workers);
    const records = listHeldSessionMessages(workspace, 'concurrent-recipient', { now: 3_000 });
    assert.equal(records.length, workerCount * messagesPerWorker);
    assert.equal(new Set(records.map((record) => record.id)).size, records.length);
  });
});

test('held ledger corruption and truncation fail closed without quarantine or reset', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const file = getStateFile(workspace, 'heldSessionMessages.json');
    for (const corrupt of ['{', '{"schemaVersion":1,"records":[']) {
      fs.writeFileSync(file, corrupt, { encoding: 'utf8', mode: 0o600 });
      assert.throws(
        () => listHeldSessionMessages(workspace, 'recipient:1'),
        /store is corrupt/i,
      );
      assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
      assert.equal(
        fs.readdirSync(path.dirname(file)).some((entry) => entry.startsWith('heldSessionMessages.json.corrupt-')),
        false,
      );
    }
  });
});

test('held ledger rejects valid JSON with an invalid schema or record invariant', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const file = getStateFile(workspace, 'heldSessionMessages.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, records: [] }), {
      encoding: 'utf8', mode: 0o600,
    });
    assert.throws(
      () => listHeldSessionMessages(workspace, 'recipient:1'),
      /invalid schema/i,
    );

    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      records: [{
        ...message('invalid-expiry'),
        status: 'held',
        expiresAt: 1,
        holdReason: 'fixture',
      }],
    }), { encoding: 'utf8', mode: 0o600 });
    assert.throws(
      () => listHeldSessionMessages(workspace, 'recipient:1'),
      /invalid expiry/i,
    );
  });
});

test('held ledger refuses symlink state without changing the link target', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    const file = getStateFile(workspace, 'heldSessionMessages.json');
    const sentinel = path.join(workspace, 'held-ledger-sentinel.json');
    const sentinelContents = '{"sentinel":true}\n';
    fs.writeFileSync(sentinel, sentinelContents, { encoding: 'utf8', mode: 0o600 });
    fs.symlinkSync(sentinel, file);

    assert.throws(
      () => listHeldSessionMessages(workspace, 'recipient:1'),
      /unsafe or invalid held session message file/i,
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), sentinelContents);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  });
});

test('failed staged ledger replacement preserves the prior durable version and private mode', async () => {
  await withTempWorkspaceAsync(async (workspace) => {
    holdSessionMessage(workspace, message('durable-before'), 'fixture approval hold', 1_000);
    const file = getStateFile(workspace, 'heldSessionMessages.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    let stagedPath = '';
    __setHeldSessionMessageWriteHooksForTests({
      onStaged: (staged) => { stagedPath = staged.temporaryPath; },
      beforeCommit: () => { throw new Error('injected pre-commit crash'); },
    });
    try {
      assert.throws(
        () => holdSessionMessage(workspace, message('must-not-commit'), 'fixture approval hold', 1_001),
        /injected pre-commit crash/,
      );
    } finally {
      __setHeldSessionMessageWriteHooksForTests(undefined);
    }

    assert.ok(stagedPath);
    assert.equal(fs.existsSync(stagedPath), false, 'failed staging must be cleaned');
    assert.deepEqual(
      listHeldSessionMessages(workspace, 'recipient:1', { now: 1_002 }).map((record) => record.id),
      ['durable-before'],
    );
  });
});

function childExit(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Held-message worker exited ${code}: ${stderr}`));
    });
  });
}
