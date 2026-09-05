// ADR-045 M1 — a configurable per-model context window (`cli.contextWindows`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeContextWindows, setCliKnobOverride, _resetCliKnobsCache, migrateLegacyContextWindowsFile } from '../config/config.js';
import {
  contextWindowFor,
  contextWindowForBudget,
  _resetContextWindowCache,
  DEFAULT_CONTEXT_WINDOW,
} from '../context/contextWindow.js';

test('ADR-045 — sanitizeContextWindows keeps positive finite ints, lowercases + floors, drops bad entries', () => {
  const out = sanitizeContextWindows({
    'GPT-5': 200_000,
    'My-Local': 32_000.9, // floored
    'bad-zero': 0, // dropped
    'bad-neg': -5, // dropped
    'bad-nan': Number.NaN, // dropped
    'bad-str': '128000', // dropped
    '  spaced  ': 64_000, // trimmed + lowercased
  } as unknown);
  assert.equal(out['gpt-5'], 200_000);
  assert.equal(out['my-local'], 32_000, 'floored to an integer');
  assert.equal(out['spaced'], 64_000, 'key trimmed + lowercased');
  for (const bad of ['bad-zero', 'bad-neg', 'bad-nan', 'bad-str']) {
    assert.equal(bad in out, false, `${bad} dropped`);
  }
});

test('ADR-045 — sanitizeContextWindows ignores non-objects', () => {
  assert.deepEqual(sanitizeContextWindows(null), {});
  assert.deepEqual(sanitizeContextWindows([1, 2]), {});
  assert.deepEqual(sanitizeContextWindows('x'), {});
});

test('ADR-045 — cli.contextWindows overrides the model table for the budget window', () => {
  try {
    setCliKnobOverride({ contextWindows: { 'zzz-fake-model': 12_345 } });
    _resetContextWindowCache();
    assert.equal(contextWindowFor('zzz-fake-model'), 12_345, 'exact-id override wins');
    assert.equal(contextWindowFor('vendor/zzz-fake-model'), 12_345, 'vendor-prefix-stripped override wins');
    assert.equal(contextWindowForBudget('zzz-fake-model'), 12_345, 'budget consumer sees the override');
  } finally {
    _resetCliKnobsCache();
    _resetContextWindowCache();
  }
});

test('ADR-045 — an unknown model with no override falls back to the default window', () => {
  try {
    _resetCliKnobsCache();
    _resetContextWindowCache();
    assert.equal(contextWindowForBudget('zzz-totally-unknown-model'), DEFAULT_CONTEXT_WINDOW);
  } finally {
    _resetCliKnobsCache();
    _resetContextWindowCache();
  }
});

test('ADR-045 M5 — the legacy contextWindows.json migrates into cli.contextWindows, then is retired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-ctxm-'));
  const prev = process.env.BRAINROUTER_CONFIG_DIR;
  process.env.BRAINROUTER_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ activeServer: '', servers: {}, cli: { contextWindows: { 'gpt-5': 200_000 } } }));
    // 'GPT-5' conflicts (an explicit knob value wins); 'my-local' is new.
    fs.writeFileSync(path.join(dir, 'contextWindows.json'), JSON.stringify({ 'GPT-5': 999_999, 'my-local': 32_000 }));

    const r = migrateLegacyContextWindowsFile();
    assert.equal(r.migrated, 1, 'only the non-conflicting entry moves');

    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.cli.contextWindows['gpt-5'], 200_000, 'explicit cli value wins over the legacy file');
    assert.equal(cfg.cli.contextWindows['my-local'], 32_000, 'the new legacy entry is migrated');
    assert.ok(!fs.existsSync(path.join(dir, 'contextWindows.json')), 'the legacy file is retired');
    assert.ok(fs.existsSync(path.join(dir, 'contextWindows.json.migrated')), 'renamed to .migrated');

    // Idempotent: a second run (no file) is a no-op.
    assert.equal(migrateLegacyContextWindowsFile().migrated, 0);
  } finally {
    if (prev === undefined) delete process.env.BRAINROUTER_CONFIG_DIR;
    else process.env.BRAINROUTER_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
