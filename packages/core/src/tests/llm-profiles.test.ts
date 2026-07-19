/**
 * MC-D3 — named LLM profiles + agent-initiated switch_model.
 *
 * Pure over `resolveCliKnobs` (profile sanitization + active pointer) and the
 * provider profile helpers (overlay resolution, switch validation, tool
 * availability) — no live provider, no config file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCliKnobs, sanitizeLlmProfiles } from '../config/config.js';
import type { Config, LLMConfig } from '../config/config.js';
import {
  applyActiveLlmProfile,
  listLlmProfileNames,
  overlayLlmProfile,
  resolveProfileSwitch,
  switchModelToolAvailable,
} from '../provider/llmProfiles.js';
import { BUILTIN_TOOL_SPECS } from '../extension/builtin/toolSpecs.js';
import { registryEntry, registryAllowedTools } from '../tool/registry/registry.js';

const cfg = (cli: Config['cli']): Config => ({ activeServer: '', servers: {}, cli });

const BASE: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  model: 'base-model',
  endpoint: 'https://api.example.com/v1',
};

// --- config resolution (sanitization + active pointer) ----------------------

test('MC-D3 resolveCliKnobs: defaults are inert (no profiles, no active pointer)', () => {
  const k = resolveCliKnobs(cfg({}));
  assert.deepEqual(k.llmProfiles, {});
  assert.equal(k.activeLlmProfile, '');
});

test('MC-D3 sanitize: drops blank names, model-less entries; trims + validates fields', () => {
  const raw = {
    '  fast ': { model: '  mini-1  ', endpoint: ' https://alt.example.com/v1 ', reasoningEffort: 'low', fast: true },
    'strong': { model: 'big-1', reasoningEffort: 'xhigh' },
    'no-model': { endpoint: 'https://x.example.com' },
    '': { model: 'ghost' },
    'bad-effort': { model: 'm', reasoningEffort: 'ultra' },
    'bad-fast': { model: 'm2', fast: 'yes' },
  } as any;
  const out = sanitizeLlmProfiles(raw);
  assert.deepEqual(Object.keys(out).sort(), ['bad-effort', 'bad-fast', 'fast', 'strong']);
  assert.deepEqual(out['fast'], { model: 'mini-1', endpoint: 'https://alt.example.com/v1', reasoningEffort: 'low', fast: true });
  assert.equal(out['bad-effort'].reasoningEffort, undefined, 'unknown effort value dropped');
  assert.equal(out['bad-fast'].fast, undefined, 'non-boolean fast dropped');
});

test('MC-D3 resolveCliKnobs: active pointer survives only when it names a valid profile', () => {
  const profiles = { a: { model: 'm-a' }, b: { model: 'm-b' } };
  assert.equal(resolveCliKnobs(cfg({ llmProfiles: profiles, activeLlmProfile: 'b' })).activeLlmProfile, 'b');
  assert.equal(resolveCliKnobs(cfg({ llmProfiles: profiles, activeLlmProfile: 'ghost' })).activeLlmProfile, '');
  assert.equal(resolveCliKnobs(cfg({ activeLlmProfile: 'a' })).activeLlmProfile, '', 'pointer without profiles is cleared');
});

// --- overlay resolution ------------------------------------------------------

test('MC-D3 overlay: profile model replaces base; endpoint only when set; key/provider carry over', () => {
  const modelOnly = overlayLlmProfile(BASE, { model: 'big-1' });
  assert.equal(modelOnly.model, 'big-1');
  assert.equal(modelOnly.endpoint, BASE.endpoint, 'endpoint inherited when profile has none');
  assert.equal(modelOnly.apiKey, BASE.apiKey);
  assert.equal(modelOnly.provider, BASE.provider);

  const withEndpoint = overlayLlmProfile(BASE, { model: 'mini-1', endpoint: 'https://alt.example.com/v1' });
  assert.equal(withEndpoint.endpoint, 'https://alt.example.com/v1');
});

test('MC-D3 overlay: the saved-provider models allowlist never rides along', () => {
  const base: LLMConfig = { ...BASE, models: ['base-model', 'other'] };
  const out = overlayLlmProfile(base, { model: 'big-1' });
  assert.equal(out.models, undefined);
});

test('MC-D3 applyActiveLlmProfile: inert when unset/unknown, overlays when valid', () => {
  const profiles = { strong: { model: 'big-1' } };
  assert.deepEqual(applyActiveLlmProfile({ llmProfiles: {}, activeLlmProfile: '' }, BASE), BASE);
  assert.deepEqual(applyActiveLlmProfile({ llmProfiles: profiles, activeLlmProfile: 'ghost' }, BASE), BASE);
  const applied = applyActiveLlmProfile({ llmProfiles: profiles, activeLlmProfile: 'strong' }, BASE);
  assert.equal(applied.model, 'big-1');
});

// --- switch_model availability (offered only with 2+ profiles) ---------------

test('MC-D3 switch_model availability: hidden at 0–1 profiles, offered at 2+', () => {
  assert.equal(switchModelToolAvailable(undefined), false);
  assert.equal(switchModelToolAvailable({}), false);
  assert.equal(switchModelToolAvailable({ a: { model: 'm' } }), false);
  assert.equal(switchModelToolAvailable({ a: { model: 'm' }, b: { model: 'n' } }), true);
});

test('MC-D3 listLlmProfileNames: sorted, empty-safe', () => {
  assert.deepEqual(listLlmProfileNames(undefined), []);
  assert.deepEqual(listLlmProfileNames({ b: { model: 'm' }, a: { model: 'n' } }), ['a', 'b']);
});

// --- switch validation + effect ----------------------------------------------

const TWO = { fast: { model: 'mini-1' }, strong: { model: 'big-1', endpoint: 'https://alt.example.com/v1', reasoningEffort: 'xhigh' as const } };

test('MC-D3 resolveProfileSwitch: refuses with fewer than 2 profiles', () => {
  const r = resolveProfileSwitch('fast', { fast: { model: 'mini-1' } }, BASE);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /fewer than 2/);
});

test('MC-D3 resolveProfileSwitch: unknown/blank target names the configured list', () => {
  const unknown = resolveProfileSwitch('ghost', TWO, BASE);
  assert.equal(unknown.ok, false);
  assert.match((unknown as any).error, /Unknown LLM profile "ghost"/);
  assert.match((unknown as any).error, /fast, strong/);

  const blank = resolveProfileSwitch('   ', TWO, BASE);
  assert.equal(blank.ok, false);
  assert.match((blank as any).error, /requires a profile name/);
});

test('MC-D3 resolveProfileSwitch: success returns the overlaid LLM for the next turn', () => {
  const r = resolveProfileSwitch('strong', TWO, BASE);
  assert.equal(r.ok, true);
  const ok = r as Extract<typeof r, { ok: true }>;
  assert.equal(ok.name, 'strong');
  assert.equal(ok.llm.model, 'big-1');
  assert.equal(ok.llm.endpoint, 'https://alt.example.com/v1');
  assert.equal(ok.llm.apiKey, BASE.apiKey, 'credentials always carry over');
  assert.equal(ok.profile.reasoningEffort, 'xhigh');
});

test('MC-D3 resolveProfileSwitch: availableModels gate applies when enforced (and always in Fast mode)', () => {
  const opts = { availableModels: ['mini-1'], enforceAvailableModels: true };
  const denied = resolveProfileSwitch('strong', TWO, BASE, opts);
  assert.equal(denied.ok, false);
  assert.match((denied as any).error, /restricts models/);

  const allowed = resolveProfileSwitch('fast', TWO, BASE, opts);
  assert.equal(allowed.ok, true);

  // Not enforced → any profile model passes …
  assert.equal(resolveProfileSwitch('strong', TWO, BASE, { availableModels: ['mini-1'] }).ok, true);
  // … except in Fast mode, which always enforces (mirrors the /model gate).
  const fastDenied = resolveProfileSwitch('strong', TWO, BASE, { availableModels: ['mini-1'], fastMode: true });
  assert.equal(fastDenied.ok, false);
  assert.match((fastDenied as any).error, /Fast mode/);
});

// --- registry / spec wiring ----------------------------------------------------

test('MC-D3 switch_model is spec\'d + registered read-tier/read_only/serialized', () => {
  const spec = (BUILTIN_TOOL_SPECS as Array<{ name: string }>).find((t) => t.name === 'switch_model');
  assert.ok(spec, 'switch_model has a required capability-extension spec');
  const entry = registryEntry('switch_model');
  assert.ok(entry, 'switch_model has a registry entry');
  assert.equal(entry!.accessTier, 'read');
  assert.equal(entry!.actionKind, 'read_only');
  assert.equal(entry!.parallelSafe, false);
  assert.ok(registryAllowedTools('read').has('switch_model'), 'exposed from the read tier up');
});
