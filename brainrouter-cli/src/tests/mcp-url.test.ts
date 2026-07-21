import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '@kinqs/brainrouter-core/config';
import {
  configuredMcpCredentialValues,
  isLocalMcpHttpUrl,
  redactMcpErrorText,
  stripMcpStdioCredentials,
} from '../cli/mcpUrl.js';

test('MCP URL locality comes from the parsed hostname only', () => {
  assert.equal(isLocalMcpHttpUrl('http://localhost:3747/mcp'), true);
  assert.equal(isLocalMcpHttpUrl('http://127.0.0.1:3747/mcp'), true);
  assert.equal(isLocalMcpHttpUrl('http://[::1]:3747/mcp'), true);
  assert.equal(isLocalMcpHttpUrl('https://evil.example/localhost'), false);
  assert.equal(isLocalMcpHttpUrl('not-a-url'), false);
});

test('MCP error redaction scrubs exact stdio credentials but preserves safe paths', () => {
  const secrets = [
    'mauve-cinder-4815',
    'amber-forest-9274',
    'violet-river-6382',
    'silver-cloud-2468',
    'copper-field-1357',
    'indigo-stone-8642',
  ];
  const safePaths = [
    '/Users/example/.keys/service.pem',
    '/Users/example/.tokens/service.txt',
    '/etc/ssl/certs/service-ca.pem',
    '/Users/example/project',
  ];
  const config: Config = {
    activeServer: 'connector',
    servers: {
      connector: {
        type: 'stdio',
        command: '/opt/connectors/service-mcp',
        args: [
          '--token',
          secrets[0],
          `--api-key=${secrets[1]}`,
          `GITHUB_TOKEN=${secrets[2]}`,
          '--header',
          'Authorization:',
          'Bearer',
          secrets[3],
          `--header=X-Api-Key: ${secrets[4]}`,
          'Bearer',
          secrets[5],
          '--private-key-path',
          safePaths[0],
          '--token-file',
          safePaths[1],
          `--ca-bundle=${safePaths[2]}`,
          '--root',
          safePaths[3],
        ],
      },
    },
  };

  const configuredSecrets = configuredMcpCredentialValues(config, 'connector');
  for (const secret of secrets) assert.ok(configuredSecrets.includes(secret));
  for (const safePath of safePaths) assert.equal(configuredSecrets.includes(safePath), false);

  const error = redactMcpErrorText(
    `spawn failed: ${[...secrets, ...safePaths].join(' ')}`,
    config,
    'connector',
  );
  for (const secret of secrets) assert.equal(error.includes(secret), false);
  for (const safePath of safePaths) assert.ok(error.includes(safePath));
});

test('MCP error redaction handles inline and split authorization values', () => {
  const secrets = [
    'crimson-orbit-1584',
    'teal-harbor-2695',
    'golden-meadow-3706',
    'navy-comet-4817',
  ];
  const config: Config = {
    activeServer: 'connector',
    servers: {
      connector: {
        type: 'stdio',
        command: 'connector-mcp',
        args: [
          `Authorization: Bearer ${secrets[0]}`,
          '--header=Authorization:',
          'Bearer',
          secrets[1],
          '--header',
          `X-Api-Key: ${secrets[2]}`,
          `--access-token=Bearer ${secrets[3]}`,
        ],
      },
    },
  };

  const error = redactMcpErrorText(secrets.join(' | '), config, 'connector');
  for (const secret of secrets) assert.equal(error.includes(secret), false);
  assert.equal(error, '[redacted] | [redacted] | [redacted] | [redacted]');
});

test('MCP logout strips inline stdio credentials without deleting safe file and path arguments', () => {
  const safe = [
    '--private-key-path',
    '/Users/example/.keys/service.pem',
    '--token-file',
    '/Users/example/.tokens/service.txt',
    '--ca-bundle=/etc/ssl/certs/service-ca.pem',
    '--root',
    '/Users/example/project',
    '--header',
    'X-Workspace: engineering',
    '--env',
    'PATH=/usr/local/bin:/usr/bin',
    '--mode=stdio',
  ];
  const stripped = stripMcpStdioCredentials([
    '--token',
    'mauve-cinder-4815',
    '--api-key=amber-forest-9274',
    'BRAINROUTER_API_KEY=violet-river-6382',
    '--header',
    'Authorization:',
    'Bearer',
    'silver-cloud-2468',
    '--header=X-Api-Key: copper-field-1357',
    'Bearer',
    'indigo-stone-8642',
    '--endpoint=https://user:password@example.com/mcp',
    '--server=https://example.com/mcp?access_token=secret-value',
    '--endpoint',
    'https://example.com/token/another-secret/mcp',
    '--env',
    'BRAINROUTER_API_KEY=environment-secret',
    '--env=ACCESS_TOKEN=second-environment-secret',
    '--auth-header',
    'Bearer generic-header-secret',
    ...safe,
  ]);

  assert.deepEqual(stripped, safe);
});
