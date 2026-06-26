import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initWizardState,
  nextStep,
  prevStep,
  reduceWizard,
  STEP_ORDER,
} from '../cli/wizard/types.js';
import {
  detectProviderFromEnv,
  findProvider,
  maskApiKey,
  PROVIDER_CATALOG,
  validateApiKey,
} from '@kinqs/brainrouter-core/dist/provider/catalog.js';
import { initPickerState, reducePicker } from '../cli/cliPrompt.js';
import {
  findProviderByEndpoint,
  isLoopbackEndpoint,
  normalizeProviderEndpoint,
  LOCAL_PLACEHOLDER_KEY,
} from '@kinqs/brainrouter-core/dist/provider/providers/index.js';

// --- Step ordering -----------------------------------------------------

test('STEP_ORDER starts at welcome and ends at done', () => {
  assert.equal(STEP_ORDER[0], 'welcome');
  assert.equal(STEP_ORDER[STEP_ORDER.length - 1], 'done');
});

test('nextStep / prevStep walk the ordered list and return undefined at the edges', () => {
  assert.equal(nextStep('welcome'), 'theme');
  assert.equal(nextStep('theme'), 'provider');
  assert.equal(nextStep('done'), undefined);
  assert.equal(prevStep('welcome'), undefined);
  assert.equal(prevStep('theme'), 'welcome');
});

// --- Wizard reducer ----------------------------------------------------

test('reduceWizard advance applies the draft patch and moves to the next step', () => {
  const s0 = initWizardState();
  assert.equal(s0.currentStep, 'welcome');
  const s1 = reduceWizard(s0, { kind: 'advance', patch: {} });
  assert.equal(s1.currentStep, 'theme');
  const s2 = reduceWizard(s1, { kind: 'advance', patch: { theme: 'dark' } });
  assert.equal(s2.currentStep, 'provider');
  assert.equal(s2.draft.theme, 'dark');
});

test('reduceWizard advance on the final step is a no-op (commit owns the terminal transition)', () => {
  let s = initWizardState();
  for (const _ of STEP_ORDER.slice(0, -1)) {
    s = reduceWizard(s, { kind: 'advance', patch: {} });
  }
  assert.equal(s.currentStep, 'done');
  const s2 = reduceWizard(s, { kind: 'advance', patch: {} });
  assert.equal(s2, s, 'advance from done returns the same state object');
});

test('reduceWizard back rewinds one step; no-op on welcome', () => {
  const s0 = initWizardState();
  const s1 = reduceWizard(s0, { kind: 'back' });
  assert.equal(s1, s0, 'back from welcome is a no-op');

  const advance = reduceWizard(s0, { kind: 'advance', patch: {} });
  const back = reduceWizard(advance, { kind: 'back' });
  assert.equal(back.currentStep, 'welcome');
});

test('reduceWizard abort marks the wizard aborted and is sticky', () => {
  const s0 = initWizardState();
  const aborted = reduceWizard(s0, { kind: 'abort' });
  assert.equal(aborted.aborted, true);
  // Subsequent events are ignored once aborted.
  const stillAborted = reduceWizard(aborted, { kind: 'advance', patch: { theme: 'mono' } });
  assert.equal(stillAborted, aborted);
});

test('reduceWizard warn appends the message without moving the step', () => {
  const s0 = initWizardState();
  const warned = reduceWizard(s0, { kind: 'warn', message: 'unusual key prefix' });
  assert.equal(warned.warnings.length, 1);
  assert.equal(warned.warnings[0].message, 'unusual key prefix');
  assert.equal(warned.currentStep, 'welcome');
});

test('reduceWizard commit only fires on the done step', () => {
  const s0 = initWizardState();
  const noop = reduceWizard(s0, { kind: 'commit' });
  assert.equal(noop.committed, false, 'commit on welcome is a no-op');

  let s = s0;
  for (const _ of STEP_ORDER.slice(0, -1)) {
    s = reduceWizard(s, { kind: 'advance', patch: {} });
  }
  assert.equal(s.currentStep, 'done');
  const committed = reduceWizard(s, { kind: 'commit' });
  assert.equal(committed.committed, true);
});

// --- Provider catalog --------------------------------------------------

test('PROVIDER_CATALOG = the picker-visible built-in providers (code modules)', () => {
  const ids = PROVIDER_CATALOG.map((p) => p.id);
  // Built-in providers live as code modules under provider/providers/. The Onyx
  // Models-panel redesign re-introduced branded per-vendor providers
  // (anthropic, gemini, openrouter, groq, azure, zenmux) as first-class
  // picker-visible entries alongside the OpenAI-compatible/local ones.
  assert.deepEqual(ids.sort(), ['anthropic', 'azure', 'gemini', 'groq', 'lmstudio', 'ollama', 'openai', 'openai-compatible', 'opencode', 'openrouter', 'zenmux']);
  // deepseek is DEFINED (for its tier ladder) but pickerVisible:false → hidden;
  // the old anthropic-via-gateway alias stays gone from the picker.
  for (const removed of ['deepseek', 'anthropic-via-gateway']) {
    assert.ok(!ids.includes(removed), `${removed} should not be in the picker`);
  }
  assert.ok(PROVIDER_CATALOG.some((p) => p.local), 'at least one local provider (LM Studio / Ollama)');
});

test('findProvider returns the entry for known ids and undefined for unknown', () => {
  assert.equal(findProvider('openai')?.label, 'OpenAI');
  assert.equal(findProvider('lmstudio')?.local, true);
  assert.equal(findProvider('deepseek'), undefined, 'deepseek removed in 0.3.9 slim');
  assert.equal(findProvider('not-a-real-provider'), undefined);
});

test('detectProviderFromEnv picks the first catalog entry whose envKey is set', () => {
  // PROVIDER_CATALOG order = precedence. OpenAI is first.
  const detected = detectProviderFromEnv({ OPENAI_API_KEY: 'sk-fake' } as any);
  assert.equal(detected?.id, 'openai');

  // Empty env → nothing detected.
  const nothing = detectProviderFromEnv({} as any);
  assert.equal(nothing, undefined);

  // Removed-provider env vars no longer match.
  const stale = detectProviderFromEnv({ DEEPSEEK_API_KEY: 'dsk-fake' } as any);
  assert.equal(stale, undefined, 'DEEPSEEK_API_KEY should no longer pre-select anything');
});

// --- Endpoint-based provider resolution --------------------------------

test('normalizeProviderEndpoint collapses /v1, /chat/completions, trailing slash + case', () => {
  assert.equal(normalizeProviderEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com');
  assert.equal(normalizeProviderEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com');
  assert.equal(normalizeProviderEndpoint('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com');
  assert.equal(normalizeProviderEndpoint('https://API.DeepSeek.com/v1/'), 'https://api.deepseek.com');
  assert.equal(normalizeProviderEndpoint(undefined), '');
});

test('findProviderByEndpoint matches CLOUD providers by endpoint, never local ones', () => {
  // Cloud: both DeepSeek base-URL forms resolve to the hidden deepseek definition.
  assert.equal(findProviderByEndpoint('https://api.deepseek.com/v1')?.id, 'deepseek');
  assert.equal(findProviderByEndpoint('https://api.deepseek.com')?.id, 'deepseek');
  assert.equal(findProviderByEndpoint('https://api.openai.com/v1')?.id, 'openai');
  assert.equal(findProviderByEndpoint('https://opencode.ai/zen/v1')?.id, 'opencode');
  // Local endpoints are ambiguous (any OpenAI-compatible server) → never inferred.
  assert.equal(findProviderByEndpoint('http://localhost:1234/v1'), undefined);
  assert.equal(findProviderByEndpoint('http://localhost:11434/v1'), undefined);
  // Empty endpoint (the generic openai-compatible) never matches.
  assert.equal(findProviderByEndpoint(''), undefined);
  assert.equal(findProviderByEndpoint('https://unknown.example.com/v1'), undefined);
});

test('isLoopbackEndpoint accepts the local-server host forms, rejects cloud', () => {
  for (const e of ['http://localhost:1234/v1', 'http://127.0.0.1:11434/v1', 'http://0.0.0.0:8080', 'http://[::1]:1234/v1']) {
    assert.equal(isLoopbackEndpoint(e), true, e);
  }
  for (const e of ['https://api.openai.com/v1', 'https://api.deepseek.com', undefined as any]) {
    assert.equal(isLoopbackEndpoint(e), false, String(e));
  }
});

test('LOCAL_PLACEHOLDER_KEY is the single shared local bearer value', () => {
  assert.equal(LOCAL_PLACEHOLDER_KEY, 'local');
});

// --- API key validation tier -------------------------------------------

test('validateApiKey rejects empty keys for cloud providers but accepts blank for local', () => {
  const cloud = findProvider('openai')!;
  const local = findProvider('lmstudio')!;
  assert.equal(validateApiKey('', cloud).kind, 'reject');
  assert.equal(validateApiKey('', local).kind, 'accept');
});

test('validateApiKey rejects suspiciously-short cloud keys (likely paste errors)', () => {
  const cloud = findProvider('openai')!;
  const verdict = validateApiKey('short', cloud);
  assert.equal(verdict.kind, 'reject');
});

test('validateApiKey accepts known prefixes without warning', () => {
  const cloud = findProvider('openai')!;
  const verdict = validateApiKey('sk-' + 'A'.repeat(40), cloud);
  assert.equal(verdict.kind, 'accept');
  assert.equal((verdict as any).warning, undefined);
});

test('validateApiKey accepts unknown-prefix keys with a non-blocking warning', () => {
  const cloud = findProvider('openai')!;
  const verdict = validateApiKey('xyz-' + 'A'.repeat(40), cloud);
  assert.equal(verdict.kind, 'accept');
  assert.ok((verdict as any).warning, 'unrecognised prefix surfaces an advisory');
});

// --- API key masking ---------------------------------------------------

test('maskApiKey keeps the last 4 chars visible and hides the rest', () => {
  assert.equal(maskApiKey(''), '(none)');
  assert.equal(maskApiKey('abcd'), '····');
  assert.equal(maskApiKey('sk-1234567890ABCDWXYZ'), '········WXYZ');
});

// --- Picker primitive: 0.3.7 onCursorChange + prefilledOther ----------

test('initPickerState with prefilledOther opens straight into the Other free-text phase', () => {
  const s = initPickerState(
    [
      { label: 'red', description: '' },
      { label: 'blue', description: '' },
    ],
    false,
    { prefilledOther: 'green' },
  );
  assert.equal(s.awaitingOther, true);
  assert.equal(s.otherText, 'green');
  // Cursor sits on the Other row so Esc → re-render lands on it (not on row 0).
  assert.equal(s.cursor, s.options.length - 1);
});

test('initPickerState with initialCursor positions the highlight without prefilledOther', () => {
  const s = initPickerState(
    [
      { label: 'red', description: '' },
      { label: 'blue', description: '' },
      { label: 'green', description: '' },
    ],
    false,
    { initialCursor: 2 },
  );
  assert.equal(s.cursor, 2);
  assert.equal(s.awaitingOther, false);
});

test('initialCursor is clamped to the option range', () => {
  const s = initPickerState(
    [{ label: 'a', description: '' }, { label: 'b', description: '' }],
    false,
    { initialCursor: 99 },
  );
  // 2 real options + 1 Other = 3 total; max cursor is 2.
  assert.equal(s.cursor, 2);
});

test('reducePicker on a prefilledOther state advances straight to Other-text editing', () => {
  let s = initPickerState(
    [{ label: 'a', description: '' }, { label: 'b', description: '' }],
    false,
    { prefilledOther: 'foo' },
  );
  // ENTER commits "foo" as the answer (we're already in awaitingOther).
  s = reducePicker(s, { name: 'return' });
  assert.equal(s.done, true);
  assert.equal(s.result, 'foo');
});
