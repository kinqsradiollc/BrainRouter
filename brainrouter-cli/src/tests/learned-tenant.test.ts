import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCliLearnedTenant } from '../runtime/account/learnedTenant.js';

test('CLI learning pins the authenticated user and organization reported by BrainRouter', async () => {
  const requests: unknown[] = [];
  const result = await resolveCliLearnedTenant({
    servers: {
      cloud: { type: 'http', url: 'https://brain.example/mcp', apiKey: 'secret-a', identity: 'brainrouter' },
    },
    mcpClient: {
      getStatuses: () => [{ serverId: 'cloud', identity: 'brainrouter' }],
      callHostLearning: async (request) => {
        requests.push(request);
        return { content: [{ text: JSON.stringify({ userId: 'user-a', orgId: 'org-a' }) }] };
      },
    },
  });
  assert.deepEqual(requests, [{ operation: 'identity' }]);
  assert.deepEqual(result, {
    tenant: { userId: 'user-a', orgId: 'org-a' },
    enabled: true,
    source: 'server',
  });
});

test('unverified authenticated profiles disable learning and never share a local partition', async () => {
  const resolve = (apiKey: string) => resolveCliLearnedTenant({
    servers: {
      cloud: { type: 'http' as const, url: 'https://brain.example/mcp', apiKey, identity: 'brainrouter' as const },
    },
    mcpClient: {
      getStatuses: () => [{ serverId: 'cloud', identity: 'brainrouter' }],
      callHostLearning: async () => ({ isError: true, content: [{ text: 'offline' }] }),
    },
  });
  const [first, second] = await Promise.all([resolve('secret-a'), resolve('secret-b')]);
  assert.equal(first.enabled, false);
  assert.equal(second.enabled, false);
  assert.equal(first.source, 'unresolved-authenticated-profile');
  assert.notEqual(first.tenant.userId, second.tenant.userId);
  assert.doesNotMatch(first.tenant.userId, /secret-a/);
  assert.notEqual(first.tenant.userId, 'local');
});

test('a CLI with no BrainRouter profile keeps the personal local partition', async () => {
  const result = await resolveCliLearnedTenant({
    servers: { tools: { type: 'http', url: 'https://tools.example/mcp', identity: 'third-party' } },
    mcpClient: { callHostLearning: async () => { throw new Error('must not be called'); } },
  });
  assert.deepEqual(result, {
    tenant: { userId: 'local', orgId: null },
    enabled: true,
    source: 'local',
  });
});

test('CLI identity discovery matches transport profile inference and honors explicit third-party identity', async () => {
  let hostedCalls = 0;
  const hosted = await resolveCliLearnedTenant({
    servers: { cloud: { type: 'http', url: 'https://tenant.brainrouter.cloud/mcp' } },
    mcpClient: {
      callHostLearning: async () => {
        hostedCalls += 1;
        return { content: [{ text: JSON.stringify({ userId: 'user-cloud', orgId: 'org-cloud' }) }] };
      },
    },
  });
  assert.equal(hostedCalls, 1);
  assert.equal(hosted.source, 'server');

  let thirdPartyCalls = 0;
  const explicitThirdParty = await resolveCliLearnedTenant({
    servers: {
      'brainrouter-shadow': {
        type: 'http', url: 'https://tenant.brainrouter.cloud/mcp', identity: 'third-party',
      },
    },
    mcpClient: { callHostLearning: async () => { thirdPartyCalls += 1; throw new Error('must not run'); } },
  });
  assert.equal(thirdPartyCalls, 0);
  assert.equal(explicitThirdParty.source, 'local');
});
