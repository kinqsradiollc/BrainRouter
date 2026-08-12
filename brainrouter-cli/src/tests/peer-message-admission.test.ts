/**
 * ADR-034 CLI recipient-admission regressions: authority fails closed and
 * durable human decisions replay without duplicate safe-boundary input.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '@kinqs/brainrouter-core/agent';
import {
  approveHeldSessionMessage,
  HELD_SESSION_MESSAGE_MAX_AGE_MS,
  HELD_SESSION_MESSAGE_MAX_RECORDS,
  holdSessionMessage,
  listHeldSessionMessages,
  markHeldSessionMessageApplied,
  rejectHeldSessionMessage,
  type LocalSessionMessage,
  type PeerSessionSenderDetails,
  type PeerSessionSteeringInput,
} from '@kinqs/brainrouter-core/session';
import { getStateFile, writeJsonFile } from '@kinqs/brainrouter-core/storage';
import {
  admitPeerMessageForAgent,
  authorityForAgent,
} from '../runtime/federation/peerMessageAdmission.js';

const ORIGINAL_HOME = process.env.BRAINROUTER_HOME;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-peer-admission-'));
process.env.BRAINROUTER_HOME = path.join(TEST_ROOT, 'home');
after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = ORIGINAL_HOME;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function message(id: string): LocalSessionMessage {
  return {
    id,
    senderSessionKey: 'peer:sender',
    senderDeviceId: '11111111-1111-4111-8111-111111111111',
    targetSessionKey: 'peer:recipient',
    text: `content for ${id}`,
    source: 'peer-session',
    trust: 'untrusted-session',
    createdAt: Date.now() - 10,
    receivedAt: Date.now(),
  };
}

test('CLI approval uses InteractionPort and retains host-resolved local provenance', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'direct-'));
  const senderDetails: PeerSessionSenderDetails = {
    transport: 'local',
    clientKind: 'cli',
    title: 'Local peer',
    workspaceRoot: '/repos/local-peer',
  };
  let directInput: PeerSessionSteeringInput | undefined;
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'read',
    interactionPort: {
      confirm: async () => true,
      choice: async () => null,
    },
    requestSteer: (text: string, options: any) => {
      directInput = {
        id: options.id,
        text,
        createdAt: options.createdAt,
        source: options.source,
        sender: options.sender,
        expiresAt: options.expiresAt,
      };
      return directInput;
    },
  } as unknown as Agent;

  const incoming = message('direct-receipt');
  incoming.expiresAt = incoming.createdAt + 60_000;
  assert.equal(await admitPeerMessageForAgent(agent, incoming, senderDetails), 'queued');
  assert.equal(directInput?.expiresAt, incoming.expiresAt);
  assert.deepEqual(directInput?.sender, {
    sessionKey: 'peer:sender',
    deviceId: '11111111-1111-4111-8111-111111111111',
    sentAt: directInput?.sender.sentAt,
    transport: 'local',
    clientKind: 'cli',
    title: 'Local peer',
    workspaceRoot: '/repos/local-peer',
  });
});

test('missing interaction port leaves the durable row held with remote provenance', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'held-'));
  const senderDetails: PeerSessionSenderDetails = {
    transport: 'remote',
    clientKind: 'desktop',
    title: 'Remote peer',
    workspaceRoot: '/repos/remote-peer',
  };
  let directCalls = 0;
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'write',
    requestPeerSessionSteer: () => { directCalls += 1; },
  } as unknown as Agent;

  assert.equal(await admitPeerMessageForAgent(agent, message('held-receipt'), senderDetails), 'held');
  assert.equal(directCalls, 0);
  const held = listHeldSessionMessages(workspaceRoot, 'peer:recipient', { status: 'held' });
  assert.equal(held.length, 1);
  assert.deepEqual(held[0]?.senderDetails, senderDetails);

  const approved = approveHeldSessionMessage(workspaceRoot, 'peer:recipient', 'held-receipt');
  assert.deepEqual(approved.input?.sender, {
    sessionKey: 'peer:sender',
    deviceId: '11111111-1111-4111-8111-111111111111',
    sentAt: approved.input?.sender.sentAt,
    transport: 'remote',
    clientKind: 'desktop',
    title: 'Remote peer',
    workspaceRoot: '/repos/remote-peer',
  });
});

test('dismissed approval stays held while explicit rejection remains terminal', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'dismissed-'));
  let prompts = 0;
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'read',
    interactionPort: {
      confirm: async () => { prompts += 1; return false; },
      choice: async () => null,
    },
    requestSteer: () => { throw new Error('must not queue'); },
  } as unknown as Agent;
  const incoming = message('dismissed-receipt');
  assert.equal(await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' }), 'held');
  assert.equal(listHeldSessionMessages(workspaceRoot, incoming.targetSessionKey)[0]?.status, 'held');
  rejectHeldSessionMessage(workspaceRoot, incoming.targetSessionKey, incoming.id);
  assert.equal(await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' }), 'rejected');
  assert.equal(prompts, 1, 'a rejected replay never opens another approval prompt');
});

test('literal CLI No is durably declined and exact terminal replay never prompts twice', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'declined-'));
  let prompts = 0;
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'read',
    interactionPort: {
      confirm: async () => { throw new Error('generic boolean confirmation must not decide'); },
      choice: async () => null,
      confirmExplicit: async () => { prompts += 1; return 'declined'; },
    },
    requestSteer: () => { throw new Error('declined input must not queue'); },
  } as unknown as Agent;
  const incoming = message('declined-receipt');

  assert.equal(await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' }), 'declined');
  const terminal = listHeldSessionMessages(workspaceRoot, incoming.targetSessionKey)[0];
  assert.equal(terminal?.status, 'rejected', 'the compact local terminal state remains rejected');
  assert.equal(terminal?.terminalReceiptStatus, 'declined');
  assert.equal(await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' }), 'declined');
  assert.equal(prompts, 1, 'durable decline replay never presents another prompt');
});

test('CLI approval prompt strips ANSI, OSC, and C0 controls from peer-owned fields', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'prompt-sanitize-'));
  const hostile = '\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b]0;forged title\u0007\u001b[31m';
  const incoming = {
    ...message('prompt-sanitize'),
    text: `ordinary first line\nordinary second line ${hostile}`,
  };
  let detail = '';
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'read',
    interactionPort: {
      confirm: async () => false,
      choice: async () => null,
      confirmExplicit: async (request: { detail?: string }) => {
        detail = request.detail ?? '';
        return 'dismissed';
      },
    },
  } as unknown as Agent;

  assert.equal(await admitPeerMessageForAgent(agent, incoming, {
    transport: 'remote',
    title: 'Validated sender title',
  }), 'held');
  assert.match(detail, /ordinary first line\nordinary second line/);
  assert.match(detail, /peer:sender/);
  assert.doesNotMatch(detail, /\u001b|\u0007|\u0000|\u0008/);
  assert.doesNotMatch(detail, /Y2xpcGJvYXJk|forged title/);
});

test('delayed CLI approval and decline resolve as expired instead of terminal human decisions', async (t) => {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });

  for (const decision of ['approved', 'declined'] as const) {
    const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, `delayed-${decision}-`));
    let settle!: (value: 'approved' | 'declined') => void;
    const response = new Promise<'approved' | 'declined'>((resolve) => { settle = resolve; });
    let queued = 0;
    const agent = {
      workspaceRoot,
      getAccessMode: () => 'read',
      interactionPort: {
        confirm: async () => false,
        choice: async () => null,
        confirmExplicit: async () => response,
      },
      requestSteer: () => { queued += 1; },
    } as unknown as Agent;
    const incoming = message(`delayed-${decision}`);
    const admission = admitPeerMessageForAgent(agent, incoming, { transport: 'remote' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = incoming.receivedAt + HELD_SESSION_MESSAGE_MAX_AGE_MS + 1;
    settle(decision);

    assert.equal(await admission, 'expired');
    assert.equal(
      listHeldSessionMessages(workspaceRoot, incoming.targetSessionKey)
        .find((record) => record.id === incoming.id)?.status,
      'expired',
    );
    assert.equal(queued, 0, 'expired content never reaches the Agent safe-boundary queue');
    clock += 1;
  }
});

test('approved and applied replay states requeue once then report lost acknowledgement', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'terminal-replay-'));
  const queued: string[] = [];
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'write',
    requestSteer: (_text: string, options: any) => { queued.push(options.id); },
  } as unknown as Agent;
  const incoming = message('terminal-replay');
  await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' });
  approveHeldSessionMessage(workspaceRoot, incoming.targetSessionKey, incoming.id);
  assert.equal(await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' }), 'queued');
  assert.deepEqual(queued, [incoming.id]);
  markHeldSessionMessageApplied(workspaceRoot, incoming.targetSessionKey, incoming.id);
  assert.equal(await admitPeerMessageForAgent(agent, incoming, { transport: 'remote' }), 'applied');
  assert.deepEqual(queued, [incoming.id]);
});

test('read access does not claim unknown MCP or external mutation surfaces are denied', () => {
  const agent = { getAccessMode: () => 'read' } as unknown as Agent;
  assert.deepEqual(authorityForAgent(agent), {
    workspaceFiles: 'denied',
    shell: 'denied',
    computerUse: 'denied',
    externalWrites: 'unknown',
    remoteTools: 'unknown',
  });
});

test('full durable held queue is reported as queue_full instead of recipient rejection', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'held-capacity-'));
  const records = Array.from({ length: HELD_SESSION_MESSAGE_MAX_RECORDS }, (_, index) => {
    const incoming = message(`capacity-${index}`);
    return {
      ...incoming,
      status: 'rejected' as const,
      expiresAt: incoming.receivedAt + HELD_SESSION_MESSAGE_MAX_AGE_MS,
      holdReason: 'Prior terminal refusal.',
      decidedAt: incoming.receivedAt,
      terminalReceiptStatus: 'rejected' as const,
    };
  });
  writeJsonFile(getStateFile(workspaceRoot, 'heldSessionMessages.json'), {
    schemaVersion: 1,
    records,
  });
  const agent = {
    workspaceRoot,
    getAccessMode: () => 'read',
    interactionPort: {
      confirm: async () => { throw new Error('capacity refusal must not prompt'); },
      choice: async () => null,
      confirmExplicit: async () => { throw new Error('capacity refusal must not prompt'); },
    },
    requestSteer: () => { throw new Error('capacity refusal must not queue'); },
  } as unknown as Agent;

  assert.equal(
    await admitPeerMessageForAgent(agent, message('capacity-overflow'), { transport: 'remote' }),
    'queue_full',
  );
  assert.equal(
    listHeldSessionMessages(workspaceRoot, 'peer:recipient').length,
    HELD_SESSION_MESSAGE_MAX_RECORDS,
  );
});
