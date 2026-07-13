import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMcpProxyEnv } from '../entry/mcpProxyCommand.js';
import type { Config } from '@kinqs/brainrouter-core/config';

test('MCP proxy injects the active sealed credential without altering other env', () => {
  const config = {
    activeServer: 'primary',
    servers: { primary: { type: 'http', url: 'https://brain.example/mcp', apiKey: 'br_secret' } },
  } as Config;
  const env = resolveMcpProxyEnv(config, { PATH: '/bin', BRAINROUTER_API_KEY: 'stale' });
  assert.equal(env.BRAINROUTER_API_KEY, 'br_secret');
  assert.equal(env.PATH, '/bin');
  assert.doesNotMatch(JSON.stringify(config.servers?.primary), /mcp-proxy/);
});

test('MCP proxy preserves an explicit environment credential when no profile key exists', () => {
  const env = resolveMcpProxyEnv({} as Config, { BRAINROUTER_API_KEY: 'br_env' });
  assert.equal(env.BRAINROUTER_API_KEY, 'br_env');
});
