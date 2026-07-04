import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_CONFIG_SCHEMA,
  configSchemaFields,
  findConfigSchemaField,
  getConfigValueAtPath,
  setConfigValueAtPath,
} from '../config/configSchema.js';

test('CLI_CONFIG_SCHEMA covers known knob groups', () => {
  assert.equal(CLI_CONFIG_SCHEMA.version, 1);
  assert.equal(CLI_CONFIG_SCHEMA.root, 'cli');
  for (const path of ['maxOutputTokens', 'autoCompactTokens', 'budget.maxPerTaskTokens', 'nextActionPlanner', 'notifyBell']) {
    assert.ok(findConfigSchemaField(path), `schema should include ${path}`);
  }
  assert.ok(configSchemaFields('modelLimits').length >= 5);
  assert.ok(configSchemaFields('notifications').length >= 2);
});

test('config schema path helpers read and write nested cli values', () => {
  const cli: Record<string, unknown> = {};
  setConfigValueAtPath(cli, 'budget.maxPerTaskTokens', 100);
  assert.deepEqual(cli, { budget: { maxPerTaskTokens: 100 } });
  assert.equal(getConfigValueAtPath(cli, 'budget.maxPerTaskTokens'), 100);
  setConfigValueAtPath(cli, 'budget.maxPerTaskTokens', null);
  assert.deepEqual(cli, { budget: {} });
});
