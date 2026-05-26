import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScrubbedConfigJson,
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
