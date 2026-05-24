import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listKnownConfigKeys,
  parseConfigArgs,
} from '../cli/commands/config.js';

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
