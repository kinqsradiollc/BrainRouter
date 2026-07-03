/**
 * MC-D1 — critic gate + bounded iterative refinement.
 *
 * Pure/unit coverage with an INJECTED fake LLM (no live provider):
 *   - parseCriticOutput: tool-args JSON, fenced/prose fallbacks, clamping,
 *     taxonomy filtering, garbage → null.
 *   - runCritic: injected completion; a throwing/unparseable backend → null
 *     (fail-open contract).
 *   - refineUntilAccepted: bounded (NEVER exceeds maxIterations), early stop on
 *     acceptance, best-result selection, fail-open on a missing verdict, and a
 *     verify-regressing refinement being discarded.
 *   - cli.critic knobs: disabled by default (zero behavior change), validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRITIC_CATEGORIES,
  CRITIC_TOOL,
  buildCriticPrompt,
  parseCriticOutput,
  runCritic,
  type CriticInput,
  type CriticResult,
} from '../review/critic.js';
import {
  buildCriticRefinePlan,
  refineUntilAccepted,
  shouldRunCriticGate,
  executionVerifyGreen,
} from '../orchestration/workflow/buildLoop.js';
import type { PhasePlanExecution } from '../orchestration/workflow/phaseOrchestrator.js';
import { resolveCliKnobs } from '../config/config.js';

const cfg = (cli: Record<string, unknown>) => ({ activeServer: '', servers: {}, cli } as any);

const CRITIC_INPUT: CriticInput = {
  task: 'Add a retry helper',
  diffSummary: 'src/retry.ts | 40 ++++',
  testOutput: 'PASS 12 tests',
  transcriptTail: 'Implemented retry with backoff.',
};

// ---------------------------------------------------------------------------
// parseCriticOutput
// ---------------------------------------------------------------------------

test('MC-D1 parseCriticOutput: accepts forced tool-call arguments JSON', () => {
  const raw = JSON.stringify({
    score: 0.85,
    diagnostics: [{ category: 'insufficient_testing', detail: 'No test covers the error branch.' }],
  });
  assert.deepEqual(parseCriticOutput(raw), {
    score: 0.85,
    diagnostics: [{ category: 'insufficient_testing', detail: 'No test covers the error branch.' }],
  });
});

test('MC-D1 parseCriticOutput: clamps score into [0,1] + accepts numeric strings', () => {
  assert.equal(parseCriticOutput('{"score": 1.4, "diagnostics": []}')?.score, 1);
  assert.equal(parseCriticOutput('{"score": -0.3, "diagnostics": []}')?.score, 0);
  assert.equal(parseCriticOutput('{"score": "0.5", "diagnostics": []}')?.score, 0.5);
});

test('MC-D1 parseCriticOutput: drops diagnostics outside the taxonomy or without detail', () => {
  const raw = JSON.stringify({
    score: 0.4,
    diagnostics: [
      { category: 'unaddressed_requirement', detail: 'The flag was never wired.' },
      { category: 'made_up_category', detail: 'should be dropped' },
      { category: 'regression_risk', detail: '   ' },
      'not-an-object',
    ],
  });
  assert.deepEqual(parseCriticOutput(raw)?.diagnostics, [
    { category: 'unaddressed_requirement', detail: 'The flag was never wired.' },
  ]);
});

test('MC-D1 parseCriticOutput: falls back to a fenced json block, then a prose-embedded object', () => {
  const fenced = 'Here is my critique:\n```json\n{"score": 0.6, "diagnostics": []}\n```\nDone.';
  assert.equal(parseCriticOutput(fenced)?.score, 0.6);
  const prose = 'I would rate this {"score": 0.2, "diagnostics": []} overall.';
  assert.equal(parseCriticOutput(prose)?.score, 0.2);
});

test('MC-D1 parseCriticOutput: garbage / missing / non-numeric score → null (fail-open)', () => {
  assert.equal(parseCriticOutput(''), null);
  assert.equal(parseCriticOutput('the changes look fine to me'), null);
  assert.equal(parseCriticOutput('{"diagnostics": []}'), null);
  assert.equal(parseCriticOutput('{"score": "high", "diagnostics": []}'), null);
  assert.equal(parseCriticOutput('[0.5]'), null);
});

test('MC-D1 taxonomy: the tool schema pins exactly the six categories', () => {
  assert.deepEqual([...CRITIC_CATEGORIES], [
    'insufficient_testing',
    'loop_behavior',
    'unaddressed_requirement',
    'incomplete_implementation',
    'regression_risk',
    'style_only',
  ]);
  assert.deepEqual(CRITIC_TOOL.parameters.properties.diagnostics.items.properties.category.enum, [...CRITIC_CATEGORIES]);
});

// ---------------------------------------------------------------------------
// runCritic (injected fake LLM)
// ---------------------------------------------------------------------------

const FAKE_LLM = { provider: 'openai', apiKey: 'k', model: 'cheap' } as any;

test('MC-D1 runCritic: returns the parsed verdict from the injected completion', async () => {
  let seenTool = '';
  const result = await runCritic(CRITIC_INPUT, {
    llm: FAKE_LLM,
    complete: async (req) => {
      seenTool = req.tool.name;
      assert.ok(req.user.includes('Add a retry helper'));
      return '{"score": 0.9, "diagnostics": []}';
    },
  });
  assert.equal(seenTool, 'report_critique'); // structured tool-call, not prose JSON
  assert.deepEqual(result, { score: 0.9, diagnostics: [] });
});

test('MC-D1 runCritic: throwing or unparseable backend → null (never a failing score)', async () => {
  assert.equal(await runCritic(CRITIC_INPUT, { llm: FAKE_LLM, complete: async () => { throw new Error('down'); } }), null);
  assert.equal(await runCritic(CRITIC_INPUT, { llm: FAKE_LLM, complete: async () => 'no json here' }), null);
});

test('MC-D1 buildCriticPrompt: bounds long evidence sections', () => {
  const prompt = buildCriticPrompt({ ...CRITIC_INPUT, testOutput: 'x'.repeat(50_000) });
  assert.ok(prompt.length < 25_000, `prompt stays bounded (got ${prompt.length})`);
});

// ---------------------------------------------------------------------------
// refineUntilAccepted (bounded loop; fakes only)
// ---------------------------------------------------------------------------

const exec = (marker: string, verifyOutput = 'PASS all green'): PhasePlanExecution => ({
  status: 'completed',
  phases: [
    { id: 'implement', title: 'Implement', status: 'completed', children: [], output: marker },
    { id: 'verify', title: 'Verify', status: 'completed', children: [], output: verifyOutput },
    { id: 'review', title: 'Review', status: 'completed', children: [], output: 'no blockers' },
  ],
});

const scoreOf = (s: number): CriticResult => ({
  score: s,
  diagnostics: s < 1 ? [{ category: 'incomplete_implementation', detail: 'still missing pieces' }] : [],
});

test('MC-D1 refine: first score at/above threshold → no refinement rounds', async () => {
  let plans = 0;
  const { execution, outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.7, maxIterations: 2 },
    async () => scoreOf(0.7),
    async () => { plans++; return exec('refined'); },
  );
  assert.equal(plans, 0);
  assert.equal(outcome?.iterations, 0);
  assert.equal(outcome?.accepted, true);
  assert.equal(execution.phases[0].output, 'initial');
});

test('MC-D1 refine: persistently low score NEVER exceeds maxRefinementIterations', async () => {
  let plans = 0;
  const { outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.9, maxIterations: 3 },
    async () => scoreOf(0.1),
    async () => { plans++; return exec(`round-${plans}`); },
  );
  assert.equal(plans, 3, 'exactly maxIterations refinement plans, no more');
  assert.equal(outcome?.iterations, 3);
  assert.equal(outcome?.accepted, false);
});

test('MC-D1 refine: maxIterations 0 → score once, never refine', async () => {
  let plans = 0;
  const { outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.9, maxIterations: 0 },
    async () => scoreOf(0.1),
    async () => { plans++; return exec('refined'); },
  );
  assert.equal(plans, 0);
  assert.equal(outcome?.iterations, 0);
});

test('MC-D1 refine: stops on the first round that crosses the threshold', async () => {
  const scores = [0.3, 0.8];
  let plans = 0;
  const { execution, outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.7, maxIterations: 5 },
    async () => scoreOf(scores.shift() ?? 0),
    async () => { plans++; return exec(`round-${plans}`); },
  );
  assert.equal(plans, 1);
  assert.equal(outcome?.accepted, true);
  assert.equal(outcome?.score, 0.8);
  assert.equal(execution.phases[0].output, 'round-1', 'refined outputs spliced over the execution');
});

test('MC-D1 refine: proceeds with the BEST-scored result when never accepted', async () => {
  const scores = [0.3, 0.6, 0.4]; // initial, round-1, round-2 — round-1 is best
  let plans = 0;
  const { execution, outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.9, maxIterations: 2 },
    async () => scoreOf(scores.shift() ?? 0),
    async () => { plans++; return exec(`round-${plans}`); },
  );
  assert.equal(outcome?.score, 0.6);
  assert.equal(outcome?.accepted, false);
  assert.equal(execution.phases[0].output, 'round-1', 'best result wins, not the last one');
});

test('MC-D1 refine: no verdict on the FIRST score → untouched execution + null outcome (fail-open)', async () => {
  let plans = 0;
  const initial = exec('initial');
  const { execution, outcome } = await refineUntilAccepted(
    initial,
    { threshold: 0.9, maxIterations: 2 },
    async () => null,
    async () => { plans++; return exec('refined'); },
  );
  assert.equal(plans, 0);
  assert.equal(outcome, null);
  assert.equal(execution, initial);
});

test('MC-D1 refine: a mid-loop scoring outage stops the loop with the best so far', async () => {
  const scores: Array<CriticResult | null> = [scoreOf(0.3), null];
  let plans = 0;
  const { execution, outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.9, maxIterations: 4 },
    async () => scores.shift() ?? null,
    async () => { plans++; return exec(`round-${plans}`); },
  );
  assert.equal(plans, 1, 'stops instead of burning the remaining budget blind');
  assert.equal(outcome?.score, 0.3);
  assert.equal(execution.phases[0].output, 'initial', 'unverdicted refinement not adopted as best');
});

test('MC-D1 refine: a refinement that turns Verify red is discarded', async () => {
  const scores = [0.3, 0.95];
  let plans = 0;
  const { execution, outcome } = await refineUntilAccepted(
    exec('initial'),
    { threshold: 0.9, maxIterations: 4 },
    async () => scoreOf(scores.shift() ?? 0),
    async () => { plans++; return exec(`round-${plans}`, 'FAIL: 2 failed'); },
  );
  assert.equal(plans, 1);
  assert.equal(execution.phases[0].output, 'initial', 'red refinement never becomes the result');
  assert.equal(outcome?.score, 0.3);
});

// ---------------------------------------------------------------------------
// gate predicate + refinement plan shape
// ---------------------------------------------------------------------------

test('MC-D1 shouldRunCriticGate: only when enabled AND verify green', () => {
  assert.equal(shouldRunCriticGate({ enabled: false }, true), false);
  assert.equal(shouldRunCriticGate({ enabled: false }, false), false);
  assert.equal(shouldRunCriticGate({ enabled: true }, false), false, 'critic layers on top of verify, never replaces it');
  assert.equal(shouldRunCriticGate({ enabled: true }, true), true);
});

test('MC-D1 executionVerifyGreen: mirrors the merge gate verdict', () => {
  assert.equal(executionVerifyGreen(exec('x', 'PASS all green')), true);
  assert.equal(executionVerifyGreen(exec('x', '2 failed')), false);
  const noVerify: PhasePlanExecution = { status: 'completed', phases: [exec('x').phases[0]] };
  assert.equal(executionVerifyGreen(noVerify), true, 'no verify phase counts as green (matches finalizeBuildLoop)');
});

test('MC-D1 buildCriticRefinePlan: static shape normalizes + carries the diagnostics punch list', () => {
  const plan = buildCriticRefinePlan(
    [{ category: 'insufficient_testing', detail: 'error branch untested' }],
    0.42,
    1,
  );
  assert.deepEqual(plan.phases.map((p) => p.id), ['implement', 'verify', 'review']);
  const prompt = plan.phases[0].agents?.[0]?.prompt ?? '';
  assert.ok(prompt.includes('[insufficient_testing] error branch untested'));
  assert.ok(prompt.includes('0.42'));
});

// ---------------------------------------------------------------------------
// cli.critic knobs — disabled by default = zero behavior change
// ---------------------------------------------------------------------------

test('MC-D1 cli.critic knobs: OFF by default with documented defaults', () => {
  assert.deepEqual(resolveCliKnobs(cfg({})).critic, {
    enabled: false,
    threshold: 0.7,
    maxRefinementIterations: 2,
    model: '',
  });
  // Default-off + the pure gate predicate ⇒ the build loop never scores.
  assert.equal(shouldRunCriticGate(resolveCliKnobs(cfg({})).critic, true), false);
});

test('MC-D1 cli.critic knobs: validation + clamping', () => {
  const k = resolveCliKnobs(cfg({ critic: { enabled: true, threshold: 0.9, maxRefinementIterations: 5, model: ' fast-tier ' } })).critic;
  assert.deepEqual(k, { enabled: true, threshold: 0.9, maxRefinementIterations: 5, model: 'fast-tier' });
  // Out-of-range / junk values fall back safely.
  assert.equal(resolveCliKnobs(cfg({ critic: { threshold: 1.7 } })).critic.threshold, 0.7);
  assert.equal(resolveCliKnobs(cfg({ critic: { threshold: -1 } })).critic.threshold, 0.7);
  assert.equal(resolveCliKnobs(cfg({ critic: { maxRefinementIterations: 99 } })).critic.maxRefinementIterations, 8);
  assert.equal(resolveCliKnobs(cfg({ critic: { maxRefinementIterations: -2 } })).critic.maxRefinementIterations, 0);
  assert.equal(resolveCliKnobs(cfg({ critic: { enabled: 'yes' } })).critic.enabled, false, 'only literal true enables');
  assert.equal(resolveCliKnobs(cfg({ critic: { model: 42 } })).critic.model, '');
});
