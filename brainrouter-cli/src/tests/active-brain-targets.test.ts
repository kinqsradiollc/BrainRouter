import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '@kinqs/brainrouter-core/config';
import { runMcpInstall } from '../cli/commands/mcpInstall/index.js';
import { resolveGithubHttpTarget } from '../entry/githubCommand.js';
import { resolveMcpProxyEnv } from '../entry/mcpProxyCommand.js';
import { resolveChatSyncTarget } from '../runtime/chatSync/chatSyncClient.js';

const config: Config = {
  activeServer: 'tools',
  activeBrainrouterServer: 'cloud',
  servers: {
    tools: {
      type: 'http',
      url: 'https://tools.example.test/mcp',
      apiKey: 'third-party-key',
      identity: 'third-party',
    },
    cloud: {
      type: 'http',
      url: 'https://brain.example.test/mcp',
      apiKey: 'brain-key',
      identity: 'brainrouter',
    },
  },
};

test('account and proxy consumers use the active brain, not the banner highlight', () => {
  assert.deepEqual(resolveChatSyncTarget(config), {
    baseUrl: 'https://brain.example.test',
    apiKey: 'brain-key',
  });
  assert.deepEqual(resolveGithubHttpTarget(config), {
    baseUrl: 'https://brain.example.test',
    apiKey: 'brain-key',
  });

  const env = resolveMcpProxyEnv(config, { BRAINROUTER_API_KEY: 'environment-key' });
  assert.equal(env.BRAINROUTER_API_KEY, 'brain-key');

  const install = runMcpInstall(['cursor'], config);
  assert.equal(install.ok, true);
  assert.match(install.output, /brain\.example\.test/);
  assert.match(install.output, /brain-key/);
  assert.doesNotMatch(install.output, /tools\.example\.test|third-party-key/);
});
