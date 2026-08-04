/**
 * ADR-027 D6 (P4-5) — workbench parity, agent-operable.
 *
 * The claim "the agent can drive the workbench" is only worth anything if it is
 * checkable. These tests check the two ways it silently stops being true: an
 * action classified with the wrong effect, and a capability that exists but was
 * never declared.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  workbenchRegistry,
  parityGaps,
  WORKBENCH_ACTION_IDS,
  type WorkbenchHandlers,
} from '../workbench/workbenchActions.js';
import { invoke, describeForModel, confirmationTokenFor, readOnlyView } from '../workbench/controlLayer.js';

function handlers(): WorkbenchHandlers & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => (args: Record<string, unknown>) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    return { ok: true };
  };
  return {
    calls,
    listSessions: record('listSessions'),
    openSession: record('openSession'),
    renameSession: record('renameSession'),
    archiveSession: record('archiveSession'),
    deleteSession: record('deleteSession'),
    listWorkspaces: record('listWorkspaces'),
    switchWorkspace: record('switchWorkspace'),
    pinSessionToWorktree: record('pinSessionToWorktree'),
    listAttachments: record('listAttachments'),
    readAttachment: record('readAttachment'),
    runLocalReview: record('runLocalReview'),
    describeStack: record('describeStack'),
    adviseStacking: record('adviseStacking'),
    openPanel: record('openPanel'),
    setTheme: record('setTheme'),
  };
}

test('the whole inventory builds and validates', () => {
  // createRegistry validates ids, titles, and parameter descriptions, so this
  // failing means a spec is malformed rather than merely missing.
  const registry = workbenchRegistry(handlers());
  assert.equal(registry.actions.size, WORKBENCH_ACTION_IDS.length);
  assert.deepEqual([...registry.actions.keys()].sort(), [...WORKBENCH_ACTION_IDS]);
});

test('archive is reversible and delete is destructive — not the other way round', () => {
  // The same distinction the inactivity sweep draws. Inverted, the agent would
  // be prompted for the safe action and not for the unsafe one.
  const registry = workbenchRegistry(handlers());
  assert.equal(registry.actions.get('session.archive')!.effect, 'mutate');
  assert.equal(registry.actions.get('session.delete')!.effect, 'destructive');
});

test('deleting a session requires its own confirmation token', async () => {
  const h = handlers();
  const registry = workbenchRegistry(h);
  await assert.rejects(() => invoke(registry, 'session.delete', { sessionId: 's1' }));
  assert.deepEqual(h.calls, [], 'the handler must not run without confirmation');

  await invoke(registry, 'session.delete', { sessionId: 's1' },
    { confirmation: confirmationTokenFor('session.delete') });
  assert.deepEqual(h.calls, ['deleteSession:{"sessionId":"s1"}']);
});

test('archiving needs no confirmation, because it is recoverable', async () => {
  const h = handlers();
  await invoke(workbenchRegistry(h), 'session.archive', { sessionId: 's1' });
  assert.deepEqual(h.calls, ['archiveSession:{"sessionId":"s1"}']);
});

test('every read action is genuinely read-only', () => {
  // A mutating action mislabelled `read` would survive into a read-only agent
  // session, which is the one place the label is load-bearing.
  const registry = workbenchRegistry(handlers());
  const reads = [...registry.actions.values()].filter((a) => a.effect === 'read').map((a) => a.id);
  assert.deepEqual(reads.sort(), [
    'attachment.list', 'attachment.read', 'review.runlocal',
    'session.list', 'stack.advise', 'stack.describe', 'workspace.list',
  ]);
});

test('a read-only session can inspect but cannot delete or switch', async () => {
  const view = readOnlyView(workbenchRegistry(handlers()));
  assert.ok(view.actions.has('session.list'));
  await assert.rejects(() => invoke(view, 'session.delete', { sessionId: 's' },
    { confirmation: confirmationTokenFor('session.delete') }));
  await assert.rejects(() => invoke(view, 'workspace.switch', { workspaceRoot: '/x' }));
});

test('arguments reach the handler and bad ones never do', async () => {
  const h = handlers();
  const registry = workbenchRegistry(h);
  await invoke(registry, 'session.rename', { sessionId: 's1', name: 'New' });
  assert.equal(h.calls.length, 1);
  await assert.rejects(() => invoke(registry, 'session.rename', { sessionId: 's1' }));
  await assert.rejects(() => invoke(registry, 'session.rename', { sessionId: 's1', name: 'x', extra: 1 }));
  assert.equal(h.calls.length, 1, 'no further handler calls from rejected invocations');
});

test('the model sees every action, with destructive ones marked', () => {
  const described = describeForModel(workbenchRegistry(handlers()));
  assert.equal(described.length, WORKBENCH_ACTION_IDS.length);
  const del = described.find((d) => d.name === 'session.delete')!;
  assert.equal(del.requiresConfirmation, true);
  assert.match(del.description, /DESTRUCTIVE/);
  // Every description must be non-empty — it is the model's only basis for
  // choosing between similarly named actions.
  assert.ok(described.every((d) => d.description.trim().length > 10));
});

test('parity gaps are reported rather than assumed absent', () => {
  // Parity decays: someone adds a panel and the agent silently cannot open it.
  assert.deepEqual(parityGaps([...WORKBENCH_ACTION_IDS]), []);
  assert.deepEqual(
    parityGaps([...WORKBENCH_ACTION_IDS, 'meetings.start', 'track.createissue']),
    ['meetings.start', 'track.createissue'],
  );
});

test('the worktree pin is exposed, so P5-1 is reachable by the agent', () => {
  // Decoupling the execution root is only useful if something can set it.
  const registry = workbenchRegistry(handlers());
  const pin = registry.actions.get('session.pintoworktree')!;
  assert.equal(pin.effect, 'mutate');
  assert.deepEqual(Object.keys(pin.params).sort(), ['sessionId', 'worktreePath']);
});

test('stack actions are agent-reachable, and adding a layer is not destructive', () => {
  // Opening a pull request is reversible by closing it; nothing existing is
  // rewritten. Classifying it destructive would put a confirmation prompt in
  // front of the safe action while the genuinely destructive ones look alike.
  const registry = workbenchRegistry(handlers());
  assert.equal(registry.actions.get('stack.describe')!.effect, 'read');
  assert.equal(registry.actions.get('stack.advise')!.effect, 'read');
  // stack.addlayer is REMOVED (ADR-028 A2) — it reported success for a pull
  // request that was never registered as a stack. Asserted absent so it cannot
  // return without the replacement that actually creates one.
  assert.equal(registry.actions.has('stack.addlayer'), false);
});
