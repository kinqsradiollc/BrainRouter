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

test('goalStore: formatGoalBlock folds wrap-up directive in on the final-budget turn (9d)', async () => {
  // Pre-9d the wrap-up text lived in a separate `buildBudgetSteeringMessage`
  // emitted as its own `goal-budget-steering` tagged system message, which
  // meant the iteration/token counts were sent twice every final-budget
  // turn (once in the anchor, once in the steering). 9d folded the wrap-up
  // into `formatGoalBlock` itself; the steering tag is gone.
  const baseGoal = {
    text: 't', setAt: '', status: 'active' as const, startedAt: '', updatedAt: '',
  };

  // Iteration-tight only — wrap-up section appears, with iteration framing.
  const iterationBlock = formatGoalBlock({
    ...baseGoal,
    budget: { maxIterations: 10, iterationsUsed: 9 },
  }, { finalBudgetTurn: true });
  assert.match(iterationBlock, /Final iteration — wrap up cleanly/);
  assert.match(iterationBlock, /iteration budget/);
  assert.doesNotMatch(iterationBlock, /token cap/);

  // Token-tight only (iterations have headroom: 4/20 used).
  const tokenBlock = formatGoalBlock({
    ...baseGoal,
    budget: { maxIterations: 20, iterationsUsed: 4, maxTokens: 10_000, tokensUsed: 8_500 },
  }, { finalBudgetTurn: true });
  assert.match(tokenBlock, /Final iteration — wrap up cleanly/);
  assert.match(tokenBlock, /token cap will trip/);
  assert.match(tokenBlock, /8,500\/10,000/);

  // Both tight.
  const bothBlock = formatGoalBlock({
    ...baseGoal,
    budget: { maxIterations: 10, iterationsUsed: 9, maxTokens: 5_000, tokensUsed: 4_500 },
  }, { finalBudgetTurn: true });
  assert.match(bothBlock, /Both budgets are nearly exhausted/);

  // Non-final-budget turn (plenty of room) — no wrap-up section.
  const earlyBlock = formatGoalBlock({
    ...baseGoal,
    budget: { maxIterations: 20, iterationsUsed: 3 },
  });
  assert.doesNotMatch(earlyBlock, /Final iteration — wrap up cleanly/);
  assert.match(earlyBlock, /Active Goal — ACTIVE/);
});

test('goalStore: formatGoalBlock auto-detects final-budget turn from goal state (9d)', async () => {
  // No `options.finalBudgetTurn` argument — formatGoalBlock calls
  // `goalIsOnFinalBudgetTurn(goal)` internally. This is the path the
  // per-turn anchor takes from `agent.ts:680`; if the heuristic ever
  // drifts the anchor will silently stop wrapping up, so guard it.
  const onFinalTurn = formatGoalBlock({
    text: 't', setAt: '', status: 'active', startedAt: '', updatedAt: '',
    budget: { maxIterations: 5, iterationsUsed: 4 },
  });
  assert.match(onFinalTurn, /Final iteration — wrap up cleanly/);

  const notOnFinalTurn = formatGoalBlock({
    text: 't', setAt: '', status: 'active', startedAt: '', updatedAt: '',
    budget: { maxIterations: 5, iterationsUsed: 1 },
  });
  assert.doesNotMatch(notOnFinalTurn, /Final iteration — wrap up cleanly/);

  // Non-active goal must never carry the wrap-up — the goal isn't running,
  // there's nothing to steer toward. Guards the `goal.status === 'active'`
  // branch in formatGoalBlock.
  const pausedOnFinalBudget = formatGoalBlock({
    text: 't', setAt: '', status: 'paused', startedAt: '', updatedAt: '',
    budget: { maxIterations: 5, iterationsUsed: 4 },
  });
  assert.doesNotMatch(pausedOnFinalBudget, /Final iteration — wrap up cleanly/);
});

test('goalStore: buildGoalContinuationPrompt references the anchor instead of echoing the goal text (9d)', async () => {
  const { buildGoalContinuationPrompt } = await import('../state/goalStore.js');
  const goal = {
    text: 'ship the auth refactor', setAt: '', status: 'active' as const,
    startedAt: '', updatedAt: '', budget: { maxIterations: 10, iterationsUsed: 3 },
  };
  const prompt = buildGoalContinuationPrompt(goal, 'last user msg', 'previous answer');
  // The continuation prompt MUST NOT re-echo the goal text — the goal-anchor
  // system message owns it and the model already has it in immediate context.
  assert.doesNotMatch(prompt, /ship the auth refactor/);
  // It MUST point the model at the anchor.
  assert.match(prompt, /goal-anchor system message/);
  // It MUST still carry the iteration counter so the user-visible
  // `[GOAL CONTINUATION — iteration N/M]` banner stays informative,
  // and the per-turn drift check.
  assert.match(prompt, /GOAL CONTINUATION — iteration 4/);
  assert.match(prompt, /Drift check/);
  // Carries the last context for resolution.
  assert.match(prompt, /Last user message: last user msg/);
  assert.match(prompt, /previous answer/);
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

    // Bind a workflow IN THIS SESSION → resolver should now return the
    // workflow scope. 9d-bugfix: createWorkflow needs sessionKey to bind
    // per-session; without it, only the workspace-level "last used" hint
    // updates and the session stays unbound.
    const meta = createWorkflow(workspace, { title: 'multi-workflow demo', kind: 'feature-dev', sessionKey: sk });
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

test('per-workflow goal binding: setGoal writes inside workflow folder; readGoal reads it back (within the same session)', async () => {
  const { createWorkflow, getWorkflowGoalFile } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:bind';
    // 9d-bugfix: pass sessionKey so createWorkflow binds the workflow to
    // THIS session. Pre-fix it bound at workspace scope, which leaked the
    // binding (and the goal) into every other CLI session in the workspace.
    const meta = createWorkflow(workspace, { title: 'cache rewrite', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'land the cache rewrite spec', sk);

    // The file lives under the workflow folder, not the session bucket.
    const goalPath = getWorkflowGoalFile(workspace, meta.slug);
    assert.ok(fs.existsSync(goalPath), 'expected goal.json inside workflow folder');
    const onDisk = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
    assert.equal(onDisk.text, 'land the cache rewrite spec');

    // readGoal in the BOUND session returns the workflow goal.
    assert.equal(readGoal(workspace, sk)?.text, 'land the cache rewrite spec');
    // 9d-bugfix: a DIFFERENT session does NOT see the workflow's goal.
    // This is the load-bearing assertion — pre-fix it returned the goal
    // text, leaking session A's work into session B.
    assert.equal(readGoal(workspace, 'totally:different:key'), null);
  });
});

test('per-workflow goal binding: switching workflows changes which goal readGoal returns', async () => {
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:swap';
    // 9d-bugfix: pass sessionKey through so the binding is per-session.
    const a = createWorkflow(workspace, { title: 'workflow A', kind: 'feature-dev', sessionKey: sk });
    setGoal(workspace, 'goal for A', sk);
    assert.equal(readGoal(workspace, sk)?.text, 'goal for A');

    const b = createWorkflow(workspace, { title: 'workflow B', kind: 'feature-dev', sessionKey: sk });
    // createWorkflow flipped this session's pointer to B; B has no goal yet.
    assert.equal(readGoal(workspace, sk), null);

    setGoal(workspace, 'goal for B', sk);
    assert.equal(readGoal(workspace, sk)?.text, 'goal for B');

    // Flip back — A's goal is intact, unaffected by B's goal write.
    setCurrentWorkflow(workspace, a.slug, sk);
    assert.equal(readGoal(workspace, sk)?.text, 'goal for A');
  });
});

test('per-workflow goal binding: clearGoal targets the bound workflow only, leaves other workflows alone', async () => {
  const { createWorkflow, setCurrentWorkflow, getWorkflowGoalFile } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:clear-bound';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'A goal', sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'B goal', sk);

    // Clearing while B is bound only nulls B's goal.json. A is untouched.
    clearGoal(workspace, sk);
    assert.equal(readGoal(workspace, sk), null);

    setCurrentWorkflow(workspace, a.slug, sk);
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

// -----------------------------------------------------------------------
// Item 3: migration on first /workflow switch
// -----------------------------------------------------------------------

test('migrateSessionGoalToWorkflow: moves session goal into target folder; idempotent on re-run', async () => {
  const { migrateSessionGoalToWorkflow } = await import('../state/goalStore.js');
  const { getWorkflowDir, createWorkflow } = await import('../state/workflowArtifacts.js');
  const { getSessionStateFile } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:migrate-free';
    // Set a session-scoped goal first (no workflow bound).
    setGoal(workspace, 'land the migration test', sk);

    // Create a target workflow but do NOT mark it current (so the resolver
    // still resolves to session scope for setGoal above — the test would
    // otherwise route into the workflow folder immediately). For this test,
    // we set the goal first, then create the target.
    const target = createWorkflow(workspace, { title: 'target work', kind: 'feature-dev' });
    // createWorkflow flips the pointer to `target`; that's the realistic
    // switch sequence. The session bucket still holds the goal at this point.

    const sessionPath = getSessionStateFile(workspace, sk, 'goal.json');
    assert.ok(fs.existsSync(sessionPath), 'session goal should exist pre-migration');

    const outcome = migrateSessionGoalToWorkflow(workspace, sk, target.slug);
    assert.equal(outcome.migrated, true);
    assert.equal(outcome.conflict, undefined);

    // Target now has the goal; session bucket is cleared.
    const targetGoal = JSON.parse(
      fs.readFileSync(path.join(getWorkflowDir(workspace, target.slug), 'goal.json'), 'utf8'),
    );
    assert.equal(targetGoal.text, 'land the migration test');
    const sessionRaw = fs.readFileSync(sessionPath, 'utf8').trim();
    assert.ok(sessionRaw === 'null' || sessionRaw === '');

    // Second invocation is a no-op — session bucket is empty.
    const again = migrateSessionGoalToWorkflow(workspace, sk, target.slug);
    assert.equal(again.migrated, false);
  });
});

test('migrateSessionGoalToWorkflow: surfaces conflict when target already has an active goal', async () => {
  const { migrateSessionGoalToWorkflow } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:migrate-conflict';
    // Workflow target with its own goal.
    const target = createWorkflow(workspace, { title: 'busy workflow', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'target keeps working on auth', sk);

    // Flip back to no-workflow scope and set a session goal.
    setCurrentWorkflow(workspace, '', sk); // empty slug → effectively no workflow bound for the resolver
    // (Note: getCurrentWorkflow returns '' which is falsy, so the resolver falls to session.)
    setGoal(workspace, 'session is exploring caching', sk);

    // Flip the pointer back to the target — that's what /workflow switch
    // would do BEFORE running migration. The session bucket still has its
    // goal at this point (workflow scope didn't write it).
    setCurrentWorkflow(workspace, target.slug, sk);

    const outcome = migrateSessionGoalToWorkflow(workspace, sk, target.slug);
    assert.equal(outcome.migrated, false);
    assert.equal(outcome.conflict, 'target-has-open-goal');
    assert.equal(outcome.source?.text, 'session is exploring caching');
    assert.equal(outcome.target?.text, 'target keeps working on auth');
  });
});

test('migrateSessionGoalToWorkflow: target-has-open-goal also fires when target goal is paused / blocked / usage_limited (not just active)', async () => {
  // Copilot review pin: the conflict variant name was originally
  // `target-has-active-goal` but the actual trigger is "any non-complete
  // target." Lock in the broader semantics so a future rename or condition
  // tightening doesn't quietly drop paused/blocked/limited targets to
  // silent-overwrite.
  const { migrateSessionGoalToWorkflow, pauseGoal, blockGoal, usageLimitGoal, completeGoal } =
    await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:open-goal-variants';
    // Helper: build a state where the session has a goal AND the target has
    // a goal in `status`, then check that migration refuses. Clears any
    // residual session/workflow goal between iterations so the next setGoal
    // doesn't trip GoalConflictError on the previous run's leftovers.
    function expectConflict(status: 'paused' | 'blocked' | 'usage_limited'): void {
      const target = createWorkflow(workspace, { title: `target-${status}`, kind: 'spec', sessionKey: sk });
      setGoal(workspace, `target goal in ${status}`, sk);
      if (status === 'paused') pauseGoal(workspace, sk);
      if (status === 'blocked') blockGoal(workspace, sk, 'stuck');
      if (status === 'usage_limited') usageLimitGoal(workspace, sk, 'cap reached');
      // Unbind so the next setGoal lands in the session bucket. Clear any
      // residual session goal from a prior iteration before writing.
      setCurrentWorkflow(workspace, '', sk);
      clearGoal(workspace, sk);
      setGoal(workspace, `session goal vs ${status}`, sk);
      setCurrentWorkflow(workspace, target.slug, sk);
      const outcome = migrateSessionGoalToWorkflow(workspace, sk, target.slug);
      assert.equal(outcome.conflict, 'target-has-open-goal', `expected conflict for target.status=${status}`);
      assert.equal(outcome.target?.status, status);
    }
    expectConflict('paused');
    expectConflict('blocked');
    expectConflict('usage_limited');

    // Sanity check the inverse: a `complete` target is silently overwritten
    // (no conflict). The work there is already done.
    const completedTarget = createWorkflow(workspace, { title: 'finished', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'done goal', sk);
    completeGoal(workspace, sk, 'wrapped up');
    setCurrentWorkflow(workspace, '', sk);
    clearGoal(workspace, sk);
    setGoal(workspace, 'session goal vs complete', sk);
    setCurrentWorkflow(workspace, completedTarget.slug, sk);
    const out = migrateSessionGoalToWorkflow(workspace, sk, completedTarget.slug);
    assert.equal(out.conflict, undefined);
    assert.equal(out.migrated, true);
  });
});

test('applyMigrationResolution(keep-target): archives session goal into .brainrouter.migrated/, clears session bucket', async () => {
  const { migrateSessionGoalToWorkflow, applyMigrationResolution } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow, getWorkflowGoalFile } = await import('../state/workflowArtifacts.js');
  const { getCliStateDir, getSessionStateFile } = await import('../state/cliState.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:keep-target';
    const target = createWorkflow(workspace, { title: 'target', kind: 'feature-dev', sessionKey: sk });
    setGoal(workspace, 'target goal', sk);
    setCurrentWorkflow(workspace, '', sk);
    setGoal(workspace, 'session goal', sk);
    setCurrentWorkflow(workspace, target.slug, sk);

    const conflict = migrateSessionGoalToWorkflow(workspace, sk, target.slug);
    assert.equal(conflict.conflict, 'target-has-open-goal');

    const resolved = applyMigrationResolution(workspace, sk, target.slug, 'keep-target');
    assert.equal(resolved.migrated, false);
    assert.ok(resolved.archivedPath, 'expected an archive path for the rejected session goal');
    assert.ok(resolved.archivedPath!.includes('.brainrouter.migrated'));

    // Target's goal stayed.
    const onTarget = JSON.parse(fs.readFileSync(getWorkflowGoalFile(workspace, target.slug), 'utf8'));
    assert.equal(onTarget.text, 'target goal');
    // Session bucket is cleared.
    const sessionRaw = fs.readFileSync(getSessionStateFile(workspace, sk, 'goal.json'), 'utf8').trim();
    assert.ok(sessionRaw === 'null' || sessionRaw === '');
    // Archive lives in CLI state dir, not the workspace tree (Item 1 invariant).
    assert.ok(resolved.archivedPath!.startsWith(getCliStateDir(workspace)));
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter.migrated')), false);
  });
});

test('applyMigrationResolution(import-session): archives target goal, moves session goal into target folder', async () => {
  const { migrateSessionGoalToWorkflow, applyMigrationResolution } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow, getWorkflowGoalFile } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:import-session';
    const target = createWorkflow(workspace, { title: 'target', kind: 'feature-dev', sessionKey: sk });
    setGoal(workspace, 'target goal', sk);
    setCurrentWorkflow(workspace, '', sk);
    setGoal(workspace, 'session goal', sk);
    setCurrentWorkflow(workspace, target.slug, sk);

    migrateSessionGoalToWorkflow(workspace, sk, target.slug); // surfaces conflict
    const resolved = applyMigrationResolution(workspace, sk, target.slug, 'import-session');
    assert.equal(resolved.migrated, true);
    assert.ok(resolved.archivedPath, 'target goal should be archived when overwritten');

    const onTarget = JSON.parse(fs.readFileSync(getWorkflowGoalFile(workspace, target.slug), 'utf8'));
    assert.equal(onTarget.text, 'session goal');
    // Verify the archived target payload is recoverable.
    const archived = JSON.parse(fs.readFileSync(resolved.archivedPath!, 'utf8'));
    assert.equal(archived.text, 'target goal');
  });
});

// -----------------------------------------------------------------------
// Item 3: /workflow switch <slug> — WorkflowConflictError + plan helper
// -----------------------------------------------------------------------

test('planWorkflowSwitch: session → workflow flag is set when session has a goal', async () => {
  const { planWorkflowSwitch } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:plan-session';
    // Create a target workflow but unbind so subsequent setGoal lands in session bucket.
    const target = createWorkflow(workspace, { title: 'target', kind: 'feature-dev', sessionKey: sk });
    setCurrentWorkflow(workspace, '', sk);
    setGoal(workspace, 'session work', sk);

    const plan = planWorkflowSwitch(workspace, sk, target.slug);
    assert.equal(plan.fromScope.scope, 'session');
    assert.equal(plan.needsMigration, true);
    assert.equal(plan.sourceGoal?.text, 'session work');
    assert.equal(plan.targetGoal, null);
  });
});

test('planWorkflowSwitch: workflow → workflow flip with both active goals throws WorkflowConflictError', async () => {
  const { planWorkflowSwitch, WorkflowConflictError } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:plan-conflict';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'A is active', sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'B is active', sk);
    // Both A and B have active goals. Currently bound to B. Asking to switch
    // back to A must refuse with WorkflowConflictError.
    setCurrentWorkflow(workspace, b.slug, sk);
    assert.throws(
      () => planWorkflowSwitch(workspace, sk, a.slug),
      (err: unknown) =>
        err instanceof WorkflowConflictError &&
        (err as any).sourceSlug === b.slug &&
        (err as any).targetSlug === a.slug,
    );
  });
});

test('planWorkflowSwitch: workflow → workflow flip is allowed when source goal is paused', async () => {
  const { planWorkflowSwitch, pauseGoal } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:plan-paused';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'A is paused', sk);
    pauseGoal(workspace, sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'B is active', sk);

    // Bound to B; A is paused → no conflict, just a normal switch.
    setCurrentWorkflow(workspace, b.slug, sk);
    const plan = planWorkflowSwitch(workspace, sk, a.slug);
    assert.equal(plan.fromScope.scope, 'workflow');
    assert.equal(plan.needsMigration, false);
    assert.equal(plan.targetGoal?.status, 'paused');
  });
});

test('WorkflowConflictError carries both slugs + goals and a clear remediation in the message', async () => {
  const { planWorkflowSwitch, WorkflowConflictError } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:plan-err-msg';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'A goal', sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'B goal', sk);
    setCurrentWorkflow(workspace, b.slug, sk);
    try {
      planWorkflowSwitch(workspace, sk, a.slug);
      assert.fail('expected WorkflowConflictError');
    } catch (err) {
      assert.ok(err instanceof WorkflowConflictError);
      assert.equal((err as InstanceType<typeof WorkflowConflictError>).sourceSlug, b.slug);
      assert.equal((err as InstanceType<typeof WorkflowConflictError>).targetSlug, a.slug);
      assert.match((err as Error).message, /Pause one first/);
      assert.match((err as Error).message, /\/goal pause/);
    }
  });
});

// -----------------------------------------------------------------------
// Item 3: /workflows column upgrade — formatWorkflowGoalColumn + read
// -----------------------------------------------------------------------

test('formatWorkflowGoalColumn: renders each status compactly + uses formatBudget for the cap', async () => {
  const { formatWorkflowGoalColumn, DEFAULT_GOAL_BUDGET } = await import('../state/goalStore.js');
  // No goal → em-dash.
  assert.equal(formatWorkflowGoalColumn(null), 'goal:—');
  // Active with explicit budget.
  const active: any = {
    text: 't', setAt: '', status: 'active', startedAt: '', updatedAt: '',
    budget: { maxIterations: 10, iterationsUsed: 3 },
  };
  assert.equal(formatWorkflowGoalColumn(active), 'goal:active 3/10');
  // Active with the default (unlimited) budget renders the budget word, not 1000000.
  const unlimited: any = {
    ...active,
    budget: { maxIterations: DEFAULT_GOAL_BUDGET, iterationsUsed: 7 },
  };
  assert.equal(formatWorkflowGoalColumn(unlimited), 'goal:active 7/unlimited');
  // Non-active statuses are terse — no iteration ratio.
  assert.equal(formatWorkflowGoalColumn({ ...active, status: 'paused' }), 'goal:paused');
  assert.equal(formatWorkflowGoalColumn({ ...active, status: 'complete' }), 'goal:complete');
  assert.equal(formatWorkflowGoalColumn({ ...active, status: 'blocked' }), 'goal:blocked');
  // usage_limited compresses to `limited` (mirrors statusline.ts).
  assert.equal(formatWorkflowGoalColumn({ ...active, status: 'usage_limited' }), 'goal:limited');
});

test('readWorkflowGoal: returns the workflow folder goal regardless of which workflow is currently bound', async () => {
  const { readWorkflowGoal } = await import('../state/goalStore.js');
  const { createWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:read-foreign';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'A goal', sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'B goal', sk);

    // Currently bound to B — readWorkflowGoal(A) must still read A's goal,
    // not B's, and not require flipping the pointer.
    setCurrentWorkflow(workspace, b.slug, sk);
    assert.equal(readWorkflowGoal(workspace, a.slug)?.text, 'A goal');
    assert.equal(readWorkflowGoal(workspace, b.slug)?.text, 'B goal');
    // A workflow with no goal returns null.
    const c = createWorkflow(workspace, { title: 'C (no goal)', kind: 'spec', sessionKey: sk });
    setCurrentWorkflow(workspace, b.slug, sk); // unbind C (createWorkflow flipped to C)
    assert.equal(readWorkflowGoal(workspace, c.slug), null);
  });
});

// -----------------------------------------------------------------------
// Item 3: /workflow pause + /workflow resume <slug>
// -----------------------------------------------------------------------

test('per-workflow pause/resume: pausing a workflow-bound goal persists the paused status in the workflow folder', async () => {
  // Subtask 5 — /workflow pause routes through pauseGoal with the per-
  // workflow scope from Subtask 1. The status must live in the workflow's
  // own goal.json (not the session bucket) so a different session on the
  // same workspace sees the paused state too.
  const { pauseGoal, readWorkflowGoal } = await import('../state/goalStore.js');
  const { createWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:wf-pause';
    const wf = createWorkflow(workspace, { title: 'auth overhaul', kind: 'feature-dev', sessionKey: sk });
    setGoal(workspace, 'ship the auth overhaul', sk);
    const paused = pauseGoal(workspace, sk)!;
    assert.equal(paused.status, 'paused');
    // The status survives in the workflow folder, not the session bucket.
    assert.equal(readWorkflowGoal(workspace, wf.slug)?.status, 'paused');
  });
});

test('per-workflow pause/resume: resuming a different workflow flips the pointer + goal status back to active', async () => {
  const { pauseGoal, resumeGoal, readWorkflowGoal } = await import('../state/goalStore.js');
  const { createWorkflow, getCurrentWorkflow, setCurrentWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:wf-resume';
    const a = createWorkflow(workspace, { title: 'A', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'A goal', sk);
    pauseGoal(workspace, sk);
    const b = createWorkflow(workspace, { title: 'B', kind: 'spec', sessionKey: sk });
    setGoal(workspace, 'B goal', sk);
    // Bound to B, A is paused. Mimic /workflow resume A: flip pointer + resume.
    setCurrentWorkflow(workspace, a.slug, sk);
    const resumed = resumeGoal(workspace, sk)!;
    assert.equal(resumed.status, 'active');
    assert.equal(getCurrentWorkflow(workspace, sk), a.slug);
    // B's goal stayed active in B's folder; A's flipped back to active.
    assert.equal(readWorkflowGoal(workspace, a.slug)?.status, 'active');
    assert.equal(readWorkflowGoal(workspace, b.slug)?.status, 'active');
  });
});

// -----------------------------------------------------------------------
// Item 3: createWorkflow clobber prompt (detectCreateWorkflowConflict)
// -----------------------------------------------------------------------

test('detectCreateWorkflowConflict: returns null when no workflow is bound or the bound workflow has no active goal', async () => {
  const { detectCreateWorkflowConflict, createWorkflow, setCurrentWorkflow } =
    await import('../state/workflowArtifacts.js');
  const { pauseGoal } = await import('../state/goalStore.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:clobber-safe';
    // No workflow bound → safe.
    assert.equal(detectCreateWorkflowConflict(workspace, 'new feature', sk), null);

    const wf = createWorkflow(workspace, { title: 'existing', kind: 'feature-dev', sessionKey: sk });
    // Bound but no goal → safe.
    assert.equal(detectCreateWorkflowConflict(workspace, 'new feature', sk), null);

    // Bound with paused goal → safe (only ACTIVE goals trigger the prompt).
    setGoal(workspace, 'existing work', sk);
    pauseGoal(workspace, sk);
    assert.equal(detectCreateWorkflowConflict(workspace, 'new feature', sk), null);

    // Same-slug create → no pointer flip, no clobber.
    const sameAsExisting = detectCreateWorkflowConflict(workspace, wf.slug, sk);
    assert.equal(sameAsExisting, null);
  });
});

test('detectCreateWorkflowConflict: surfaces slug + status + text when the bound workflow has an active goal', async () => {
  const { detectCreateWorkflowConflict, createWorkflow } = await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:test:clobber-active';
    const wf = createWorkflow(workspace, { title: 'auth overhaul', kind: 'feature-dev', sessionKey: sk });
    setGoal(workspace, 'ship the auth overhaul', sk);
    const conflict = detectCreateWorkflowConflict(workspace, 'cache prototype', sk);
    assert.ok(conflict, 'expected a conflict when active goal would be clobbered');
    assert.equal(conflict!.currentSlug, wf.slug);
    assert.equal(conflict!.currentGoalStatus, 'active');
    assert.equal(conflict!.currentGoalText, 'ship the auth overhaul');
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

test('9d-bugfix: session B does NOT inherit session A\'s workflow binding (or its goal) via the workspace-level pointer', async () => {
  // The first incarnation of Item 3 (multi-workflow concurrency) wrote the
  // current-workflow pointer ONLY at workspace scope. Any second CLI in
  // the same workspace immediately read that pointer + the bound
  // workflow's goal.json — silently reintroducing the cross-session leak
  // PR #26 originally fixed. 9d-bugfix added a per-session pointer that
  // wins over the workspace pointer when a sessionKey is supplied.
  //
  // This test pins the contract: session A creating a workflow + setting
  // a goal must NOT bleed into session B reading either. Session B
  // remains free to `/goal` independently.
  const { createWorkflow, getCurrentWorkflow, getLastUsedWorkflow } =
    await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sessionA = 'brainrouter-cli:session:A';
    const sessionB = 'brainrouter-cli:session:B';

    // Session A: bind a workflow and set a goal inside it.
    const a = createWorkflow(workspace, { title: 'fix the X bug', kind: 'feature-dev', sessionKey: sessionA });
    setGoal(workspace, 'land the X bug fix', sessionA);
    assert.equal(getCurrentWorkflow(workspace, sessionA), a.slug, 'session A is bound');
    assert.equal(readGoal(workspace, sessionA)?.text, 'land the X bug fix');

    // Session B opens fresh in the same workspace. It must NOT see A's
    // binding NOR A's goal — even though the workspace-level "last used"
    // hint still points at the workflow.
    assert.equal(
      getCurrentWorkflow(workspace, sessionB),
      undefined,
      'session B starts unbound — no auto-inherit from workspace pointer',
    );
    assert.equal(
      readGoal(workspace, sessionB),
      null,
      'session B has no active goal — session A\'s workflow goal does not leak in',
    );

    // The workspace-level hint IS still readable for display purposes
    // ("you were last on workflow X") — but it doesn't bind the session.
    assert.equal(getLastUsedWorkflow(workspace), a.slug);

    // Session B is free to set its own independent goal, which lands in
    // its own session bucket and doesn't touch session A's workflow.
    setGoal(workspace, 'review the Y subsystem', sessionB);
    assert.equal(readGoal(workspace, sessionB)?.text, 'review the Y subsystem');
    // Session A's goal is intact.
    assert.equal(readGoal(workspace, sessionA)?.text, 'land the X bug fix');
  });
});

test('9d-bugfix: setCurrentWorkflow without sessionKey still updates the workspace-level hint (back-compat)', async () => {
  // Legacy callers (some first-run paths and external scripts) call
  // `setCurrentWorkflow(workspace, slug)` without a sessionKey. That path
  // still writes the workspace-level pointer so `getLastUsedWorkflow`
  // and `getCurrentWorkflow(workspace)` (no sessionKey) keep working —
  // they just don't bind any specific session.
  const { setCurrentWorkflow, getCurrentWorkflow, getLastUsedWorkflow } =
    await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    setCurrentWorkflow(workspace, 'legacy-slug');
    assert.equal(getLastUsedWorkflow(workspace), 'legacy-slug');
    // Display-only callers (no sessionKey) still see the workspace pointer.
    assert.equal(getCurrentWorkflow(workspace), 'legacy-slug');
    // But a fresh session still sees nothing bound.
    assert.equal(getCurrentWorkflow(workspace, 'fresh-session'), undefined);
  });
});

test('9d-bugfix: clearSessionWorkflow unbinds the session without touching the workspace hint', async () => {
  const { createWorkflow, clearSessionWorkflow, getCurrentWorkflow, getLastUsedWorkflow } =
    await import('../state/workflowArtifacts.js');
  withTempWorkspace((workspace) => {
    const sk = 'brainrouter-cli:session:clear';
    const wf = createWorkflow(workspace, { title: 'auth refactor', kind: 'feature-dev', sessionKey: sk });
    assert.equal(getCurrentWorkflow(workspace, sk), wf.slug);
    clearSessionWorkflow(workspace, sk);
    // Session is unbound now.
    assert.equal(getCurrentWorkflow(workspace, sk), undefined);
    // Workspace-level "last used" hint is preserved.
    assert.equal(getLastUsedWorkflow(workspace), wf.slug);
    // Idempotent — clearing again is a no-op, not a crash.
    clearSessionWorkflow(workspace, sk);
    assert.equal(getCurrentWorkflow(workspace, sk), undefined);
  });
});
