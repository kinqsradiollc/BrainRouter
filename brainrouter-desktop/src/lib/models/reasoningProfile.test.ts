import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningProfileForModel, reasoningPillLabel, sliderIndexForEffort, effortAtSliderFraction } from './reasoningProfile.js';
import type { ModelPolicy } from '@kinqs/brainrouter-types';

test('generic graded reasoners (GPT-5, GLM, Qwen3, DeepSeek) offer Low/Medium/High, no Extra high', () => {
  // Claude is special-cased with its own extended scale — covered separately below.
  for (const model of ['gpt-5', 'z-ai/glm-4.6', 'qwen3-30b-a3b', 'deepseek-v3.2', 'magistral-small']) {
    const p = reasoningProfileForModel(model);
    assert.equal(p.kind, 'graded', model);
    assert.deepEqual(p.options.map((o) => o.level), ['low', 'medium', 'high'], model);
    assert.equal(p.xhigh, false, model);
    assert.equal(p.min, 'low', model);
    assert.equal(p.lockedLabel, null, model);
  }
});

test('the family is carried on the profile (for the icon / label)', () => {
  assert.equal(reasoningProfileForModel('claude-opus-4-8').family, 'claude');
  assert.equal(reasoningProfileForModel('z-ai/glm-4.6').family, 'chatglm');
});

test('xhigh-capable models (gpt-5.2+, codex-max) add the Extra high tier', () => {
  for (const model of ['gpt-5.2', 'gpt-5.5-codex', 'gpt-5.1-codex-max']) {
    const p = reasoningProfileForModel(model);
    assert.equal(p.kind, 'graded', model);
    assert.equal(p.xhigh, true, model);
    assert.deepEqual(p.options.map((o) => o.level), ['low', 'medium', 'high', 'xhigh'], model);
  }
});

test('non-reasoning models (gpt-4o, *-chat) have no reasoning control', () => {
  for (const model of ['gpt-4o', 'gpt-4o-mini', 'chatgpt-4o-latest', 'gpt-4.1', 'deepseek-chat', 'gpt-5-chat-latest']) {
    const p = reasoningProfileForModel(model);
    assert.equal(p.kind, 'none', model);
    assert.deepEqual(p.options, [], model);
    assert.equal(p.min, 'medium', model);
  }
});

test('always-on reasoners (deepseek-reasoner) lock the control', () => {
  const p = reasoningProfileForModel('deepseek-reasoner');
  assert.equal(p.kind, 'always-on');
  assert.deepEqual(p.options, []);
  assert.equal(p.lockedLabel, 'Always on');
  assert.equal(p.min, 'medium');
});

test('binary on/off models (gemma-qat) offer Off / On', () => {
  const p = reasoningProfileForModel('gemma-3-12b-qat');
  assert.equal(p.kind, 'binary');
  assert.deepEqual(p.options, [
    { level: 'medium', label: 'Off' },
    { level: 'high', label: 'On' },
  ]);
});

test('an unknown chat model falls back to graded (broad, accept-and-ignore — no regression)', () => {
  const p = reasoningProfileForModel('some-local-finetune-v9');
  assert.equal(p.kind, 'graded');
  assert.equal(p.xhigh, false);
});

test('an empty/undefined model has no control (nothing selected yet)', () => {
  assert.equal(reasoningProfileForModel('').kind, 'none');
  assert.equal(reasoningProfileForModel(undefined).kind, 'none');
});

test('reasoningPillLabel reflects the family + Fast state', () => {
  const graded = reasoningProfileForModel('gpt-5.2');
  assert.equal(reasoningPillLabel(graded, 'high', false), 'High');
  assert.equal(reasoningPillLabel(graded, 'xhigh', false), 'Extra high');
  assert.equal(reasoningPillLabel(graded, 'high', true), 'Fast', 'Fast overrides the visible label');

  const binary = reasoningProfileForModel('gemma-3-12b-qat');
  assert.equal(reasoningPillLabel(binary, 'medium', false), 'Off');
  assert.equal(reasoningPillLabel(binary, 'high', false), 'On');

  const onlyOn = reasoningProfileForModel('deepseek-reasoner');
  assert.equal(reasoningPillLabel(onlyOn, 'medium', false), 'Always on');

  const none = reasoningProfileForModel('gpt-4o');
  assert.equal(reasoningPillLabel(none, 'medium', false), null, 'no pill for non-reasoning models');
});

test('sliderIndexForEffort maps the active effort to its stop on the track', () => {
  const g4 = reasoningProfileForModel('gpt-5.2'); // [low, medium, high, xhigh]
  assert.equal(sliderIndexForEffort(g4, 'low'), 0);
  assert.equal(sliderIndexForEffort(g4, 'medium'), 1);
  assert.equal(sliderIndexForEffort(g4, 'high'), 2);
  assert.equal(sliderIndexForEffort(g4, 'xhigh'), 3);

  const g3 = reasoningProfileForModel('gpt-5'); // [low, medium, high] (no xhigh)
  assert.equal(sliderIndexForEffort(g3, 'xhigh'), 2, 'xhigh on a non-xhigh model clamps to the top stop');

  const bin = reasoningProfileForModel('gemma-3-12b-qat'); // [Off=medium, On=high]
  assert.equal(sliderIndexForEffort(bin, 'medium'), 0, 'Off');
  assert.equal(sliderIndexForEffort(bin, 'high'), 1, 'On');
  assert.equal(sliderIndexForEffort(bin, 'low'), 1, 'any non-medium effort reads as On');
});

test('effortAtSliderFraction snaps a drag position to the nearest stop', () => {
  const g4 = reasoningProfileForModel('gpt-5.2'); // 4 stops
  assert.equal(effortAtSliderFraction(g4, 0), 'low');
  assert.equal(effortAtSliderFraction(g4, 1), 'xhigh');
  assert.equal(effortAtSliderFraction(g4, 0.33), 'medium', 'round(0.99) → stop 1');
  assert.equal(effortAtSliderFraction(g4, 0.66), 'high', 'round(1.98) → stop 2');
  assert.equal(effortAtSliderFraction(g4, -0.5), 'low', 'clamped past the left edge');
  assert.equal(effortAtSliderFraction(g4, 2), 'xhigh', 'clamped past the right edge');

  const bin = reasoningProfileForModel('gemma-3-12b-qat'); // 2 stops
  assert.equal(effortAtSliderFraction(bin, 0.2), 'medium', 'left half → Off');
  assert.equal(effortAtSliderFraction(bin, 0.8), 'high', 'right half → On');

  assert.equal(effortAtSliderFraction(reasoningProfileForModel('gpt-4o'), 0.5), null, 'no stops → null');
});

test('custom Claude models use the inferred scale without inventing ultracode', () => {
  const p = reasoningProfileForModel('claude-opus-4-8');
  assert.equal(p.family, 'claude');
  assert.equal(p.kind, 'graded');
  assert.equal(p.source, 'inferred');
  assert.deepEqual(p.options.map((o) => o.label), ['Low', 'Medium', 'High', 'Extra', 'Max']);
  assert.deepEqual(p.options.map((o) => o.level), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('reasoningPillLabel shows the Claude tier label (Extra, not "Extra high")', () => {
  const opus = reasoningProfileForModel('claude-opus-4-8');
  assert.equal(reasoningPillLabel(opus, 'max', false), 'Max');
  assert.equal(reasoningPillLabel(opus, 'xhigh', false), 'Extra');
  assert.equal(reasoningPillLabel(opus, 'high', false), 'High');
  assert.equal(reasoningPillLabel(opus, 'max', true), 'Fast', 'Fast still overrides');
});

test('slider math spans the custom Claude scale through max', () => {
  const opus = reasoningProfileForModel('claude-opus-4-8');
  assert.equal(sliderIndexForEffort(opus, 'max'), 4);
  assert.equal(sliderIndexForEffort(opus, 'xhigh'), 3);
  assert.equal(effortAtSliderFraction(opus, 1), 'max');
  assert.equal(effortAtSliderFraction(opus, 0.9), 'max', 'round(3.6) → Max');
});

test('managed model profile uses the exact server effort list and labels', () => {
  const policy: ModelPolicy = {
    id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'brainrouter', enabled: true,
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    reasoning: {
      default: 'high',
      allowed: [
        { id: 'none', label: 'Off' },
        { id: 'minimal', label: 'Minimal' },
        { id: 'max', label: 'Max' },
      ],
      source: 'verified', mode: 'selectable',
    },
    provenance: { source: 'verified' }, revision: 'r1',
  };
  const profile = reasoningProfileForModel(policy.id, policy);
  assert.equal(profile.source, 'server');
  assert.deepEqual(profile.options, [
    { level: 'none', label: 'Off' },
    { level: 'minimal', label: 'Minimal' },
    { level: 'max', label: 'Max' },
  ]);
});

test('managed model options are ordered Faster→Smarter regardless of server order', () => {
  // A server list sent NOT ascending must not put "Minimal" on the Smarter end or
  // make Fast (profile.min) target the highest effort.
  const policy: ModelPolicy = {
    id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'brainrouter', enabled: true,
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    reasoning: {
      default: 'high',
      allowed: [
        { id: 'max', label: 'Max' },
        { id: 'high', label: 'High' },
        { id: 'medium', label: 'Medium' },
        { id: 'minimal', label: 'Minimal' },
      ],
      source: 'verified', mode: 'selectable',
    },
    provenance: { source: 'verified' }, revision: 'r1',
  };
  const profile = reasoningProfileForModel(policy.id, policy);
  assert.deepEqual(profile.options.map((o) => o.level), ['minimal', 'medium', 'high', 'max'], 'ascending');
  assert.equal(profile.min, 'minimal', 'Fast targets the lowest effort, not the highest');
  assert.equal(sliderIndexForEffort(profile, 'minimal'), 0, 'Minimal sits at the Faster end');
  assert.equal(sliderIndexForEffort(profile, 'max'), 3, 'Max sits at the Smarter end');
});
