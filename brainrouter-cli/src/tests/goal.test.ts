import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clearGoal, formatGoalBlock, readGoal, setGoal } from '../state/goalStore.js';
import { Agent } from '../agent/agent.js';
import { withTempWorkspace } from './_helpers.js';

test('formatBudget renders the unlimited default as "unlimited" and explicit numbers as-is', async () => {
  const { formatBudget, DEFAULT_GOAL_BUDGET, UNLIMITED_BUDGET_THRESHOLD } = await import('../state/goalStore.js');
  assert.equal(formatBudget(DEFAULT_GOAL_BUDGET), 'unlimited');
  assert.equal(formatBudget(UNLIMITED_BUDGET_THRESHOLD), 'unlimited');
  assert.equal(formatBudget(UNLIMITED_BUDGET_THRESHOLD - 1), String(UNLIMITED_BUDGET_THRESHOLD - 1));
  assert.equal(formatBudget(10), '10');
  assert.equal(formatBudget(1), '1');
  // Sanity: the default is well above the threshold so out-of-the-box behavior is unlimited.
  assert.ok(DEFAULT_GOAL_BUDGET >= UNLIMITED_BUDGET_THRESHOLD, 'DEFAULT_GOAL_BUDGET should be at/above the unlimited threshold');
});

test('goalHasBudgetLeft returns true forever when default budget is in effect (effectively unlimited)', async () => {
  const { goalHasBudgetLeft, DEFAULT_GOAL_BUDGET } = await import('../state/goalStore.js');
  // Simulate a long-running goal that's done 50,000 iterations — default budget should still permit more.
  const goal: any = {
    text: 'long-running goal',
    setAt: new Date().toISOString(),
    status: 'active',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxIterations: DEFAULT_GOAL_BUDGET, iterationsUsed: 50_000 },
  };
  assert.equal(goalHasBudgetLeft(goal), true);
  // But an explicit small cap should still trip when exceeded.
  goal.budget.maxIterations = 3;
  goal.budget.iterationsUsed = 3;
  assert.equal(goalHasBudgetLeft(goal), false);
});

test('/goal text-embedded "Budget N" is parsed and stripped from goal text', () => {
  // Same shape as the regex used in the /goal handler in workflow.ts so a
  // refactor of one will fail the other. Keep them aligned.
  const re = /\bbudget[:\s]+(\d+)(?:\s*(?:iterations?|turns?|rounds?))?\.?/i;
  const cases: Array<{ input: string; expectedN: number; expectedTextSuffix: string }> = [
    { input: 'do X. Budget 3 iterations.', expectedN: 3, expectedTextSuffix: 'do X.' },
    { input: 'audit Y, Budget: 5', expectedN: 5, expectedTextSuffix: 'audit Y,' },
    { input: 'finish Z budget 12 turns', expectedN: 12, expectedTextSuffix: 'finish Z' },
    { input: 'review thing budget 1 round.', expectedN: 1, expectedTextSuffix: 'review thing' },
  ];
  for (const { input, expectedN, expectedTextSuffix } of cases) {
    const m = input.match(re);
    assert.ok(m, `expected match in: ${input}`);
    assert.equal(Number(m![1]), expectedN);
    const stripped = input.replace(m![0], '').replace(/\s{2,}/g, ' ').trim();
    assert.ok(
      stripped.endsWith(expectedTextSuffix.replace(/[.,]$/, '')) || stripped === expectedTextSuffix,
      `unexpected stripped text: "${stripped}" — expected to end with "${expectedTextSuffix}"`,
    );
  }
  // No match — should leave the text alone.
  assert.equal('plain goal text with no budget'.match(re), null);
  // Out of range (we cap at 200 in the handler) — still matches the regex,
  // but the handler ignores it. Just confirm the regex behavior here.
  const oversize = 'do thing budget 9999'.match(re);
  assert.ok(oversize);
  assert.equal(Number(oversize![1]), 9999);
});

test('goalStore: set/read/clear round-trip and formatGoalBlock includes outcome + budget', () => {
  withTempWorkspace((workspace) => {
    assert.equal(readGoal(workspace), null);
    const saved = setGoal(workspace, '   ship the auth refactor   ');
    assert.equal(saved.text, 'ship the auth refactor');
    assert.equal(saved.status, 'active');
    assert.equal(saved.budget.iterationsUsed, 0);
    assert.equal(saved.budget.maxIterations > 0, true);
    const block = formatGoalBlock(saved);
    assert.match(block, /Active Goal — ACTIVE/);
    assert.match(block, /ship the auth refactor/);
    assert.match(block, /Iteration:\*{0,2}\s+1 of/);
    clearGoal(workspace);
    assert.equal(readGoal(workspace), null);
  });
});

test('goalStore: setGoal rejects text longer than GOAL_TEXT_MAX_CHARS', async () => {
  const { GoalTooLongError, GOAL_TEXT_MAX_CHARS } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    // At-cap input is accepted.
    const atCap = 'x'.repeat(GOAL_TEXT_MAX_CHARS);
    const ok = setGoal(workspace, atCap);
    assert.equal(ok.text.length, GOAL_TEXT_MAX_CHARS);
    clearGoal(workspace);

    // One over the cap throws GoalTooLongError, carrying the original length.
    const overCap = 'y'.repeat(GOAL_TEXT_MAX_CHARS + 1);
    assert.throws(
      () => setGoal(workspace, overCap),
      (err: unknown) => err instanceof GoalTooLongError && (err as any).length === GOAL_TEXT_MAX_CHARS + 1,
    );
    // No file should have been written on rejection.
    assert.equal(readGoal(workspace), null);
  });
});

test('goalStore: lifecycle helpers — pause, resume, complete, blocked, budget, tick', async () => {
  const { pauseGoal, resumeGoal, completeGoal, blockGoal, setGoalBudget, tickGoalIteration } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sessionKey = 'brainrouter-cli:test:main';
    setGoal(workspace, 'reach the moon', sessionKey);

    let g = pauseGoal(workspace, sessionKey)!;
    assert.equal(g.status, 'paused');
    g = resumeGoal(workspace, sessionKey)!;
    assert.equal(g.status, 'active');

    g = setGoalBudget(workspace, sessionKey, 25)!;
    assert.equal(g.budget.maxIterations, 25);

    g = tickGoalIteration(workspace, sessionKey)!;
    assert.equal(g.budget.iterationsUsed, 1);

    g = blockGoal(workspace, sessionKey, 'need launch codes')!;
    assert.equal(g.status, 'blocked');
    assert.equal(g.blockedReason, 'need launch codes');

    g = completeGoal(workspace, sessionKey, 'we touched the moon')!;
    assert.equal(g.status, 'complete');
    assert.equal(typeof g.completedAt, 'string');
  });
});

test('goalStore: legacy { text, setAt } gets normalized with active status and default budget', async () => {
  const { getCliStateFile } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    fs.writeFileSync(
      getCliStateFile(workspace, 'goal.json'),
      JSON.stringify({ text: 'legacy goal', setAt: '2026-01-01T00:00:00Z' }),
    );
    const g = readGoal(workspace)!;
    assert.equal(g.text, 'legacy goal');
    assert.equal(g.status, 'active');
    assert.equal(g.budget.iterationsUsed, 0);
    assert.equal(g.budget.maxIterations > 0, true);
  });
});

test('goalStore: per-session goals are isolated from each other', () => {
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:project:main';
    const sessionB = 'brainrouter-cli:project:fork-xyz';

    setGoal(workspace, 'ship auth refactor', sessionA);
    setGoal(workspace, 'investigate flaky test', sessionB);

    assert.equal(readGoal(workspace, sessionA)?.text, 'ship auth refactor');
    assert.equal(readGoal(workspace, sessionB)?.text, 'investigate flaky test');

    clearGoal(workspace, sessionA);
    assert.equal(readGoal(workspace, sessionA), null);
    assert.equal(readGoal(workspace, sessionB)?.text, 'investigate flaky test');
  });
});

test('goalStore: setGoal throws GoalConflictError when overwriting an active goal without force', async () => {
  const { GoalConflictError, completeGoal } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:conflict';
    setGoal(workspace, 'first goal', sk);
    // Same key, new text — must conflict.
    assert.throws(
      () => setGoal(workspace, 'second goal', sk),
      (err: unknown) => err instanceof GoalConflictError && (err as any).existing.text === 'first goal',
    );
    // Existing goal preserved.
    assert.equal(readGoal(workspace, sk)?.text, 'first goal');
    // force=true overrides.
    const replaced = setGoal(workspace, 'second goal', sk, { force: true });
    assert.equal(replaced.text, 'second goal');
    assert.equal(readGoal(workspace, sk)?.text, 'second goal');
    // Completing the goal lifts the conflict shield — fresh setGoal without
    // force should now succeed because the old work is done.
    completeGoal(workspace, sk, 'manually closed');
    const next = setGoal(workspace, 'third goal', sk);
    assert.equal(next.text, 'third goal');
    assert.equal(next.status, 'active');
  });
});

test('goalStore: GoalConflictError message reflects the actual existing status', async () => {
  // Copilot review noted that the prior message hardcoded "already active"
  // even when the existing goal was paused / blocked / usage_limited,
  // misleading users via the REPL's catch path. Verify status-aware wording.
  const { GoalConflictError, pauseGoal, blockGoal, usageLimitGoal } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:conflict-msg';
    setGoal(workspace, 'first', sk);
    // Active → "is in progress"
    const active = (() => { try { setGoal(workspace, 'second', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    assert.ok(active instanceof GoalConflictError);
    assert.match(active.message, /already is in progress/);

    pauseGoal(workspace, sk);
    const paused = (() => { try { setGoal(workspace, 'third', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    assert.ok(paused instanceof GoalConflictError);
    assert.match(paused.message, /already exists with status: paused/);

    blockGoal(workspace, sk, 'stuck');
    const blocked = (() => { try { setGoal(workspace, 'fourth', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    assert.match(blocked!.message, /already exists with status: blocked/);

    usageLimitGoal(workspace, sk, 'cap reached');
    const limited = (() => { try { setGoal(workspace, 'fifth', sk); return null; } catch (e) { return e as InstanceType<typeof GoalConflictError>; } })();
    // The status label spells out 'usage limited' (underscore-stripped).
    assert.match(limited!.message, /already exists with status: usage limited/);
  });
});

test('goalStore: buildBudgetSteeringMessage differentiates iteration vs token tightness', async () => {
  // Copilot review: the message used to always say "one turn left within
  // the iteration budget" even when only the token heuristic tripped.
  // Verify each trigger gets the right wording.
  const { buildBudgetSteeringMessage } = await import('../state/goalStore.js');
  const baseGoal = {
    text: 't', setAt: '', status: 'active' as const, startedAt: '', updatedAt: '',
  };

  // Iteration-tight only.
  const iterationCase = buildBudgetSteeringMessage({
    ...baseGoal,
    budget: { maxIterations: 10, iterationsUsed: 9 },
  });
  assert.match(iterationCase, /iteration budget/);
  assert.doesNotMatch(iterationCase, /token cap/);

  // Token-tight only (iterations have headroom: 4/20 used).
  const tokenCase = buildBudgetSteeringMessage({
    ...baseGoal,
    budget: { maxIterations: 20, iterationsUsed: 4, maxTokens: 10_000, tokensUsed: 8_500 },
  });
  assert.match(tokenCase, /token cap will trip/);
  assert.match(tokenCase, /8,500\/10,000/);

  // Both tight.
  const bothCase = buildBudgetSteeringMessage({
    ...baseGoal,
    budget: { maxIterations: 10, iterationsUsed: 9, maxTokens: 5_000, tokensUsed: 4_500 },
  });
  assert.match(bothCase, /Both budgets are nearly exhausted/);
});

test('goalStore: token budget tracking + usage_limited transition', async () => {
  const { setGoalTokenBudget, addGoalTokens, usageLimitGoal, goalHasBudgetLeft, goalIsOnFinalBudgetTurn } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:tokens';
    const g0 = setGoal(workspace, 'finish auth refactor', sk);
    assert.equal(g0.budget.maxTokens, undefined);

    // Set a token cap of 1000.
    const g1 = setGoalTokenBudget(workspace, sk, 1000)!;
    assert.equal(g1.budget.maxTokens, 1000);
    assert.equal(g1.budget.tokensUsed, 0);
    assert.equal(goalHasBudgetLeft(g1), true);

    // Tally usage in chunks.
    const g2 = addGoalTokens(workspace, sk, 400)!;
    assert.equal(g2.budget.tokensUsed, 400);
    assert.equal(goalIsOnFinalBudgetTurn(g2), false);

    // 850/1000 — > 80%, considered the "final turn" for steering.
    const g3 = addGoalTokens(workspace, sk, 450)!;
    assert.equal(g3.budget.tokensUsed, 850);
    assert.equal(goalIsOnFinalBudgetTurn(g3), true);

    // Cross the cap.
    const g4 = addGoalTokens(workspace, sk, 200)!;
    assert.equal(g4.budget.tokensUsed, 1050);
    assert.equal(goalHasBudgetLeft(g4), false);

    // Transition to usage_limited.
    const limited = usageLimitGoal(workspace, sk, 'token budget reached')!;
    assert.equal(limited.status, 'usage_limited');
    assert.equal(limited.blockedReason, 'token budget reached');

    // Clearing the token cap with 0.
    const cleared = setGoalTokenBudget(workspace, sk, 0)!;
    assert.equal(cleared.budget.maxTokens, undefined);
    assert.equal(cleared.budget.tokensUsed, undefined);
  });
});

test('goalStore: editGoal unified update changes text/status/budget/tokens in one call', async () => {
  const { editGoal } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:edit';
    setGoal(workspace, 'initial outcome', sk);
    const edited = editGoal(workspace, sk, {
      text: 'refined outcome with sharper boundary',
      maxIterations: 25,
      maxTokens: 50_000,
    })!;
    assert.equal(edited.text, 'refined outcome with sharper boundary');
    assert.equal(edited.budget.maxIterations, 25);
    assert.equal(edited.budget.maxTokens, 50_000);
    assert.equal(edited.status, 'active');
    // Status-only edit.
    const paused = editGoal(workspace, sk, { status: 'paused' })!;
    assert.equal(paused.status, 'paused');
    // Empty text refused.
    assert.throws(() => editGoal(workspace, sk, { text: '   ' }), /empty/);
  });
});

test('goalStore: legacy workspace-level goal only falls back for no-session reads; first session-scoped setGoal archives it', async () => {
  const { getCliStateDir, getCliStateFile, getSessionStateDir } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    // Old layout — write directly to the workspace-level file.
    fs.writeFileSync(getCliStateFile(workspace, 'goal.json'), JSON.stringify({ text: 'legacy goal', setAt: '2026-01-01T00:00:00Z' }));
    const sessionKey = 'brainrouter-cli:project:main';
    // Without sessionKey, legacy is still readable (back-compat for very old installs).
    assert.equal(readGoal(workspace)?.text, 'legacy goal');
    // With sessionKey and no session bucket yet → null, not the legacy goal (the leakage fix).
    assert.equal(readGoal(workspace, sessionKey), null);

    setGoal(workspace, 'session-scoped', sessionKey);
    assert.equal(readGoal(workspace, sessionKey)?.text, 'session-scoped');
    // Session bucket holds the new goal.
    assert.equal(fs.existsSync(path.join(getSessionStateDir(workspace, sessionKey), 'goal.json')), true);
    // Legacy file is gone (archived, not left where another session would re-pick it up).
    assert.equal(fs.existsSync(getCliStateFile(workspace, 'goal.json')), false);
    // Archived into the per-user cli state dir, NOT into the project workspace tree.
    const archiveDir = path.join(getCliStateDir(workspace), '.brainrouter.migrated');
    const migrated = fs.readdirSync(archiveDir);
    assert.equal(migrated.length, 1);
    assert.match(migrated[0]!, /^legacy-goal-.*\.json$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(archiveDir, migrated[0]!), 'utf8')).text, 'legacy goal');
    // Guardrail: the project workspace tree is not polluted (0.3.3 invariant).
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter.migrated')), false);
  });
});

test('goalStore: session A goal does not leak into session B (regression for cross-session legacy fallback)', async () => {
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:project:sessionA';
    const sessionB = 'brainrouter-cli:project:sessionB';
    setGoal(workspace, 'A is working on the auth refactor', sessionA);
    // Opening a fresh session in the same workspace must not see A's goal.
    assert.equal(readGoal(workspace, sessionB), null);
    // A's own session still has it.
    assert.equal(readGoal(workspace, sessionA)?.text, 'A is working on the auth refactor');
  });
});

// -----------------------------------------------------------------------
// Item 3: per-workflow goal binding + priority chain (workflow > session)
// -----------------------------------------------------------------------

test('resolveGoalScope: prefers workflow scope when a workflow is bound', async () => {
  const { resolveGoalScope } = await import('../state/goalStore.js');
  const { createWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:scope-workflow';
    // No workflow yet → session scope.
    const before = resolveGoalScope(workspace, sk);
    assert.equal(before.scope, 'session');

    // Bind a workflow → resolver should now return the workflow scope.
    const meta = createWorkflow(workspace, { title: 'multi-workflow demo', kind: 'feature-dev' });
    const after = resolveGoalScope(workspace, sk);
    assert.equal(after.scope, 'workflow');
    if (after.scope === 'workflow') {
      assert.equal(after.slug, meta.slug);
      assert.ok(after.path.includes(`workflows/${meta.slug}/goal.json`));
    }
  });
});

test('resolveGoalScope: falls back to session when no workflow bound, then legacy when no sessionKey', async () => {
  const { resolveGoalScope } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:scope-session';
    const sessionScope = resolveGoalScope(workspace, sk);
    assert.equal(sessionScope.scope, 'session');
    if (sessionScope.scope === 'session') {
      assert.equal(sessionScope.sessionKey, sk);
      assert.ok(sessionScope.path.includes(`/sessions/`));
    }
    const legacyScope = resolveGoalScope(workspace);
    assert.equal(legacyScope.scope, 'legacy');
    assert.ok(legacyScope.path.endsWith('goal.json'));
  });
});

test('per-workflow goal binding: setGoal writes inside workflow folder; readGoal reads it back', async () => {
  const { createWorkflow, getWorkflowGoalFile } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:bind';
    const meta = createWorkflow(workspace, { title: 'cache rewrite', kind: 'spec' });
    setGoal(workspace, 'land the cache rewrite spec', sk);

    // The file lives under the workflow folder, not the session bucket.
    const goalPath = getWorkflowGoalFile(workspace, meta.slug);
    assert.ok(fs.existsSync(goalPath), 'expected goal.json inside workflow folder');
    const onDisk = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
    assert.equal(onDisk.text, 'land the cache rewrite spec');

    // readGoal returns the same goal regardless of which (or no) sessionKey
    // is passed, because the priority chain pins it to the workflow.
    assert.equal(readGoal(workspace, sk)?.text, 'land the cache rewrite spec');
    assert.equal(readGoal(workspace, 'totally:different:key')?.text, 'land the cache rewrite spec');
  });
});

test('per-workflow goal binding: switching workflows changes which goal readGoal returns', async () => {
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:swap';
    const a = createWorkflow(workspace, { title: 'workflow A', kind: 'feature-dev' });
    setGoal(workspace, 'goal for A', sk);
    assert.equal(readGoal(workspace, sk)?.text, 'goal for A');

    const b = createWorkflow(workspace, { title: 'workflow B', kind: 'feature-dev' });
    // createWorkflow flipped the current pointer to B; B has no goal yet.
    assert.equal(readGoal(workspace, sk), null);

    setGoal(workspace, 'goal for B', sk);
    assert.equal(readGoal(workspace, sk)?.text, 'goal for B');

    // Flip back — A's goal is intact, unaffected by B's goal write.
    setCurrentWorkflow(workspace, a.slug);
    assert.equal(readGoal(workspace, sk)?.text, 'goal for A');
  });
});

test('per-workflow goal binding: clearGoal targets the bound workflow only, leaves other workflows alone', async () => {
  const { createWorkflow, setCurrentWorkflow, getWorkflowGoalFile } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:clear-bound';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec' });
    setGoal(workspace, 'A goal', sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec' });
    setGoal(workspace, 'B goal', sk);

    // Clearing while B is bound only nulls B's goal.json. A is untouched.
    clearGoal(workspace, sk);
    assert.equal(readGoal(workspace, sk), null);

    setCurrentWorkflow(workspace, a.slug);
    assert.equal(readGoal(workspace, sk)?.text, 'A goal');
    // B's file still exists but with null payload.
    const bPath = getWorkflowGoalFile(workspace, b.slug);
    if (fs.existsSync(bPath)) {
      const raw = fs.readFileSync(bPath, 'utf8').trim();
      // writeJsonFile(null) writes "null\n"; readGoal returns null either way.
      assert.ok(raw === 'null' || raw === '');
    }
  });
});

test('Item 1 regression guard: with no workflow bound, session A goal still does not leak into session B', () => {
  // The per-workflow refactor must NOT reintroduce the cross-session leak
  // PR #26 fixed. When no workflow is bound, two sessions stay isolated.
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:project:scope-A';
    const sessionB = 'brainrouter-cli:project:scope-B';
    setGoal(workspace, 'A is exploring auth', sessionA);
    assert.equal(readGoal(workspace, sessionB), null);
    assert.equal(readGoal(workspace, sessionA)?.text, 'A is exploring auth');
  });
});

test('Agent: two CLI instances in the same workspace get distinct sessionKeys and do not share goal state', () => {
  withTempWorkspace((workspace) => {
    const stubMcp: any = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [{ text: '{}' }] }),
      close: async () => {},
    };
    const llm = { provider: 'openai' as const, apiKey: 'k', model: 'test-model' };
    // Two agents constructed back-to-back, no explicit sessionKey passed —
    // simulates two `brainrouter` CLI processes started in the same workspace.
    const agentA = new Agent(stubMcp, llm, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
    const agentB = new Agent(stubMcp, llm, { workspaceRoot: workspace, launchCwd: workspace, silent: true });
    // The previous workspace-derived fallback returned the same key for both.
    // randomUUID() must give us distinct keys per agent.
    assert.notEqual(agentA.sessionKey, agentB.sessionKey);
    // And the new keys are valid UUIDs so MCP's isUniqueId accepts them
    // and skips the workspace-cache branch entirely.
    assert.match(agentA.sessionKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(agentB.sessionKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // End-to-end: a goal set on agent A's session is invisible to agent B.
    setGoal(workspace, 'agent A is reviewing the cli refactor', agentA.sessionKey);
    assert.equal(readGoal(workspace, agentB.sessionKey), null);
    assert.equal(readGoal(workspace, agentA.sessionKey)?.text, 'agent A is reviewing the cli refactor');
  });
});
