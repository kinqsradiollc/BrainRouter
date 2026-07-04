import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAutomationKnob,
  applyProviderRequestFormat,
  buildScrubbedConfigJson,
  listKnownConfigKeys,
  listProviderRequestFormatRows,
  parseConfigArgs,
  parseSchemaValue,
  readAutomationKnob,
  formatSchemaValue,
  WIRE_FORMAT_OPTIONS,
} from '../cli/commands/config/index.js';
import { findConfigSchemaField } from '@kinqs/brainrouter-core/config';

const emptyConfig = (): any => ({ activeServer: '', servers: {} });

test('parseConfigArgs: no args → home panel', () => {
  assert.deepEqual(parseConfigArgs([]), { mode: 'home' });
});

test('parseConfigArgs: raw / --raw / json all route to the raw dump', () => {
  assert.deepEqual(parseConfigArgs(['raw']), { mode: 'raw' });
  assert.deepEqual(parseConfigArgs(['--raw']), { mode: 'raw' });
  assert.deepEqual(parseConfigArgs(['json']), { mode: 'raw' });
});

test('parseConfigArgs: single arg → get for that key (lowercased)', () => {
  assert.deepEqual(parseConfigArgs(['theme']), { mode: 'get', key: 'theme' });
  assert.deepEqual(parseConfigArgs(['THEME']), { mode: 'get', key: 'theme' });
});

test('parseConfigArgs: key + value → set, with the value joined back on space', () => {
  assert.deepEqual(parseConfigArgs(['theme', 'dark']), {
    mode: 'set', key: 'theme', value: 'dark',
  });
  assert.deepEqual(parseConfigArgs(['statusline', 'mode,branch,workflow']), {
    mode: 'set', key: 'statusline', value: 'mode,branch,workflow',
  });
});

test('parseConfigArgs: trailing whitespace is trimmed off the value', () => {
  assert.deepEqual(parseConfigArgs(['theme', '  dark  ']), {
    mode: 'set', key: 'theme', value: 'dark',
  });
});

test('listKnownConfigKeys exposes the keys /config can get/set directly', () => {
  const keys = listKnownConfigKeys();
  // Core knobs every user touches.
  for (const required of ['theme', 'statusline', 'effort', 'mode', 'review-policy', 'quiet', 'personality', 'editor', 'model', 'provider']) {
    assert.ok(keys.includes(required), `/config should support ${required}`);
  }
});

test('listKnownConfigKeys exposes the workflow-automation keys', () => {
  const keys = listKnownConfigKeys();
  for (const required of ['automation', 'automation.requirements', 'automation.sync', 'automation.sprints']) {
    assert.ok(keys.includes(required), `/config should support ${required}`);
  }
});

test('listKnownConfigKeys exposes schema-driven cli knobs', () => {
  const keys = listKnownConfigKeys();
  for (const required of ['maxOutputTokens', 'budget.maxPerTaskTokens', 'notifyBell']) {
    assert.ok(keys.includes(required), `/config should support schema key ${required}`);
  }
});

test('schema renderer maps field types to CLI values and parsers', () => {
  const numberField = findConfigSchemaField('budget.maxPerTaskTokens')!;
  const boolField = findConfigSchemaField('notifyBell')!;
  const selectField = findConfigSchemaField('nextActionPlanner')!;
  assert.equal(formatSchemaValue(numberField, undefined), '0');
  assert.deepEqual(parseSchemaValue(numberField, '42'), { ok: true, message: 'budget.maxPerTaskTokens → 42', value: 42 });
  assert.deepEqual(parseSchemaValue(boolField, 'on'), { ok: true, message: 'notifyBell → on', value: true });
  assert.deepEqual(parseSchemaValue(selectField, 'off'), { ok: true, message: 'nextActionPlanner → off', value: 'off' });
  assert.equal(parseSchemaValue(selectField, 'maybe').ok, false);
});

test('listProviderRequestFormatRows keys saved providers by runtime provider id', () => {
  const cfg = emptyConfig();
  cfg.providers = {
    prod: { provider: 'OpenAI', model: 'gpt-4.1', apiKey: 'x' },
    local: { provider: 'lmstudio', model: 'gpt-4.1', apiKey: '' },
    anotherOpenAI: { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'x' },
  };
  const rows = listProviderRequestFormatRows(cfg);
  const openaiRows = rows.filter((r) => r.id === 'openai');
  assert.equal(openaiRows.length, 1);
  assert.deepEqual(openaiRows[0].savedNames, ['prod', 'anotherOpenAI']);
  assert.ok(rows.some((r) => r.id === 'lmstudio' && r.savedNames.includes('local')));
});

test('applyProviderRequestFormat persists lowercase overrides and default clears only that key', () => {
  const cfg = emptyConfig();
  cfg.cli = { providerRequestFormat: { openrouter: 'chat-completions' } };
  assert.deepEqual(WIRE_FORMAT_OPTIONS, ['default', 'chat-completions', 'responses', 'anthropic-messages', 'gemini-generate']);
  assert.deepEqual(applyProviderRequestFormat(cfg, 'OpenAI', 'responses'), { ok: true });
  assert.deepEqual(cfg.cli.providerRequestFormat, { openrouter: 'chat-completions', openai: 'responses' });
  // Native wire formats persist for their providers too.
  assert.deepEqual(applyProviderRequestFormat(cfg, 'Anthropic', 'anthropic-messages'), { ok: true });
  assert.equal(cfg.cli.providerRequestFormat?.anthropic, 'anthropic-messages');
  assert.deepEqual(applyProviderRequestFormat(cfg, 'anthropic', 'default'), { ok: true });

  assert.deepEqual(applyProviderRequestFormat(cfg, 'openai', 'default'), { ok: true });
  assert.deepEqual(cfg.cli.providerRequestFormat, { openrouter: 'chat-completions' });

  assert.deepEqual(applyProviderRequestFormat(cfg, 'openrouter', 'default'), { ok: true });
  assert.equal(cfg.cli.providerRequestFormat, undefined);
});

test('applyAutomationKnob: master toggle on/off, rejects garbage', () => {
  const cfg = emptyConfig();
  assert.deepEqual(applyAutomationKnob(cfg, 'automation', 'on').ok, true);
  assert.equal(cfg.cli.automation.enabled, true);
  assert.deepEqual(applyAutomationKnob(cfg, 'automation', 'off').ok, true);
  assert.equal(cfg.cli.automation.enabled, false);
  const bad = applyAutomationKnob(cfg, 'automation', 'maybe');
  assert.equal(bad.ok, false);
});

test('applyAutomationKnob: requirements tier maps off/propose/autopilot', () => {
  const cfg = emptyConfig();
  applyAutomationKnob(cfg, 'automation.requirements', 'autopilot');
  assert.deepEqual(cfg.cli.automation.requirements, { enabled: true, autopilot: true });
  applyAutomationKnob(cfg, 'automation.requirements', 'propose');
  assert.deepEqual(cfg.cli.automation.requirements, { enabled: true, autopilot: false });
  applyAutomationKnob(cfg, 'automation.requirements', 'on'); // alias for propose
  assert.equal(cfg.cli.automation.requirements.autopilot, false);
  applyAutomationKnob(cfg, 'automation.requirements', 'off');
  assert.equal(cfg.cli.automation.requirements.enabled, false);
  assert.equal(applyAutomationKnob(cfg, 'automation.requirements', 'turbo').ok, false);
});

test('applyAutomationKnob: sync boolean + sprints tier', () => {
  const cfg = emptyConfig();
  applyAutomationKnob(cfg, 'automation.sync', 'on');
  assert.equal(cfg.cli.automation.sync.enabled, true);
  applyAutomationKnob(cfg, 'automation.sprints', 'autopilot');
  assert.deepEqual(cfg.cli.automation.sprints, { enabled: true, autopilot: true });
  assert.equal(applyAutomationKnob(cfg, 'automation.sprints', 'nope').ok, false);
});

test('readAutomationKnob reflects the applied state', () => {
  const cfg = emptyConfig();
  assert.equal(readAutomationKnob(cfg, 'automation'), 'off');
  assert.equal(readAutomationKnob(cfg, 'automation.requirements'), 'off');
  applyAutomationKnob(cfg, 'automation', 'on');
  applyAutomationKnob(cfg, 'automation.requirements', 'autopilot');
  applyAutomationKnob(cfg, 'automation.sprints', 'propose');
  assert.equal(readAutomationKnob(cfg, 'automation'), 'on');
  assert.equal(readAutomationKnob(cfg, 'automation.requirements'), 'autopilot');
  assert.equal(readAutomationKnob(cfg, 'automation.sprints'), 'propose');
});

test('buildScrubbedConfigJson masks LLM and MCP API keys', () => {
  const out = buildScrubbedConfigJson({
    activeServer: 'remote',
    llm: {
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-5',
      apiKey: 'sk-test-1234567890',
    },
    servers: {
      remote: {
        type: 'http',
        url: 'https://brainrouter.example/mcp',
        apiKey: 'brainrouter_remote_abcdef123456',
        env: {
          BRAINROUTER_API_KEY: 'brainrouter_env_abcdef123456',
        },
      },
    },
  } as any);

  assert.doesNotMatch(out, /sk-test-1234567890/);
  assert.doesNotMatch(out, /brainrouter_remote_abcdef123456/);
  assert.doesNotMatch(out, /brainrouter_env_abcdef123456/);
  assert.match(out, /7890/);
  assert.match(out, /3456/);
});
