/**
 * ADR-032 §5 Q4 / D4 — `/learned` is the surface that keeps the learned store
 * from being a black box that changes behaviour. These tests pin the parts of
 * it that are load-bearing rather than cosmetic:
 *
 * - the gate applies to a HUMAN correction too, because a correction nothing
 *   could contradict can never be retired by D6 and would otherwise live in
 *   every future session's context forever;
 * - `revert` actually stops the item reaching the agent, INCLUDING the skill it
 *   was promoted to — an undo that leaves the skill resolvable on disk is an
 *   undo that silently did not apply;
 * - the command does not swallow input that is not `/learned`.
 *
 * Console output is captured rather than asserted line-by-line: the wording is
 * allowed to change, the STORE TRANSITIONS are not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withTempWorkspaceAsync } from './_helpers.js';
import { tryHandleLearningCommand } from '../cli/commands/learning/index.js';
import {
  attachLearnedMemoryRecord, attachLearnedSkill, getLearnedItem, listLearnedItems, readLearningLog,
  recordHumanCorrection, resolveLearnedSkill, writeLearnedSkill,
} from '@kinqs/brainrouter-core/learning';

/** The narrow slice of CommandContext `/learned` actually reads. */
function ctx(command: string, args: string[], agentOverrides: Record<string, unknown> = {}) {
  return {
    command,
    args,
    agent: { sessionKey: 'session:test', learnedTenant: TENANT, ...agentOverrides },
  } as unknown as Parameters<typeof tryHandleLearningCommand>[0];
}

/** Swallow the command's own stdout so the suite output stays readable. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = original; }
}

const TENANT = { orgId: null, userId: 'local' };

test('/learned does not intercept other commands', async () => {
  assert.equal(await tryHandleLearningCommand(ctx('/memory', [])), false);
  assert.equal(await tryHandleLearningCommand(ctx('/learnedx', [])), false);
});

test('a human correction must name what would show it wrong', async () => {
  await withTempWorkspaceAsync(async () => {
    // Two parts instead of three: no falsifier, so D2's gate has nothing to
    // retire on later. This must be refused rather than stored unfalsifiable.
    await quietly(() => tryHandleLearningCommand(
      ctx('/learned', ['correct', 'never force-push a release branch | it stops diverging']),
    ));
    assert.equal(listLearnedItems(TENANT, { includeInactive: true }).length, 0);

    // An empty middle part is the same failure wearing three pipes.
    await quietly(() => tryHandleLearningCommand(
      ctx('/learned', ['correct', 'never force-push |  | history stops diverging']),
    ));
    assert.equal(listLearnedItems(TENANT, { includeInactive: true }).length, 0);
  });
});

test('a well-formed correction is admitted as an instruction and reaches later sessions', async () => {
  await withTempWorkspaceAsync(async () => {
    await quietly(() => tryHandleLearningCommand(ctx('/learned', [
      'correct',
      'never force-push a release branch | a force-pushed release branch still matches origin | release history stops diverging',
    ])));

    const items = listLearnedItems(TENANT);
    assert.equal(items.length, 1);
    const item = items[0]!;
    // The instruction tier is D1's human-corrected provenance — the whole point
    // of routing a correction through this command rather than the reflector.
    assert.equal(item.tier, 'instruction');
    assert.equal(item.status, 'active');
    assert.equal(item.falsifier, 'a force-pushed release branch still matches origin');
    // Provenance must survive: an item nobody can trace is one nobody can judge.
    assert.equal(item.provenance.sessionKey, 'session:test');
  });
});

test('revert stops the item reaching the agent and takes its skill down with it', async () => {
  await withTempWorkspaceAsync(async () => {
    const recorded = recordHumanCorrection({
      tenant: TENANT,
      sessionKey: 'session:test',
      statement: 'run the migration before the seed',
      falsifier: 'seeding succeeds on an unmigrated database',
      expectation: 'the seed step stops failing',
    });
    assert.equal(recorded.admitted, true);
    const id = recorded.admitted ? recorded.item.id : '';

    // Promote it to a skill so the revert has something on disk to undo. A
    // learned skill left behind would still resolve through `get_skill`, which
    // is exactly the undo-that-did-not-apply this asserts against.
    const skillId = 'learned-migration-order';
    assert.ok(writeLearnedSkill({
      tenant: TENANT,
      id: skillId,
      description: 'run the migration before the seed',
      steps: ['run the migration', 'then run the seed'],
      falsifier: 'seeding succeeds on an unmigrated database',
      learnedItemId: id,
      sessionKey: 'session:test',
      learnedAt: '2026-08-09T00:00:00.000Z',
      allowedTools: ['read_file'],
    }));
    attachLearnedSkill(TENANT, id, skillId);
    assert.ok(resolveLearnedSkill(TENANT, skillId), 'the skill must resolve before the revert');

    await quietly(() => tryHandleLearningCommand(ctx('/learned', ['revert', id, 'no', 'longer', 'true'])));

    // D4: the row SURVIVES — provenance is kept — but it stops being active.
    const after = getLearnedItem(TENANT, id);
    assert.ok(after, 'the reverted item must still exist for its provenance');
    assert.equal(after.status, 'reverted');
    assert.equal(listLearnedItems(TENANT).length, 0, 'a reverted item must not reach the agent');
    assert.equal(listLearnedItems(TENANT, { includeInactive: true }).length, 1);
    assert.equal(resolveLearnedSkill(TENANT, skillId), undefined,
      'the promoted skill must come down with the revert');

    // The audit trail is the other half of D4: an undo nobody can see happened
    // is indistinguishable from the store quietly losing a row.
    assert.ok(readLearningLog(TENANT).some((entry) => entry.op.includes('revert')));
  });
});

test('reverting an unknown id changes nothing', async () => {
  await withTempWorkspaceAsync(async () => {
    await quietly(() => tryHandleLearningCommand(ctx('/learned', ['revert', 'nope'])));
    assert.equal(listLearnedItems(TENANT, { includeInactive: true }).length, 0);
    assert.equal(readLearningLog(TENANT).length, 0);
  });
});

test('a linked revert uses the explicit tenant-bound central lifecycle RPC', async () => {
  await withTempWorkspaceAsync(async () => {
    const recorded = recordHumanCorrection({
      tenant: TENANT,
      sessionKey: 'session:test',
      statement: 'stop the worker before the migration',
      falsifier: 'the migration succeeds with the worker still running',
      expectation: 'migrations stop deadlocking',
    });
    assert.equal(recorded.admitted, true);
    const id = recorded.admitted ? recorded.item.id : '';
    attachLearnedMemoryRecord(TENANT, id, 'memory-1');
    const calls: Array<Record<string, unknown>> = [];
    const mcpClient = {
      callHostLearning: async (request: Record<string, unknown>) => {
        calls.push(request);
        return { content: [{ text: JSON.stringify({ found: true, itemId: id }) }] };
      },
    };

    await quietly(() => tryHandleLearningCommand(ctx(
      '/learned',
      ['revert', id, 'superseded', 'by', 'the', 'new', 'migration'],
      { mcpClient },
    )));

    assert.deepEqual(calls, [{
      operation: 'revert',
      input: { itemId: id, reason: 'superseded by the new migration' },
    }]);
    assert.equal(getLearnedItem(TENANT, id)?.status, 'reverted');
    assert.equal(getLearnedItem(TENANT, id)?.memoryLifecycle?.status, 'archived');
  });
});
