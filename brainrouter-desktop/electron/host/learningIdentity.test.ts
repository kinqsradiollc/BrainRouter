import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialDesktopLearningBinding,
  resolveDesktopLearningBinding,
} from './learningIdentity.js';

const hosted = {
  cloud: {
    type: 'http' as const,
    url: 'https://brain.example/mcp',
    apiKey: 'secret-a',
    identity: 'brainrouter' as const,
  },
};

test('authenticated Desktop boot starts unresolved and learning-disabled', () => {
  const binding = initialDesktopLearningBinding({ servers: hosted });
  assert.equal(binding.enabled, false);
  assert.equal(binding.source, 'unresolved-authenticated-profile');
  assert.match(binding.tenant.userId, /^unresolved-profile-/);
  assert.doesNotMatch(binding.tenant.userId, /secret-a/);
});

test('Desktop identity uses the custom host request and pins its server-owned tenant', async () => {
  const requests: unknown[] = [];
  const binding = await resolveDesktopLearningBinding({
    config: { servers: hosted, expectedUserId: 'user-a', expectedOrgId: 'org-a' },
    mcpClient: {
      getStatuses: () => [{ serverId: 'cloud', identity: 'brainrouter' }],
      callHostLearning: async (request) => {
        requests.push(request);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ userId: 'user-a', orgId: 'org-a' }) }] };
      },
    },
  });

  assert.deepEqual(requests, [{ operation: 'identity' }]);
  assert.deepEqual(binding, {
    tenant: { userId: 'user-a', orgId: 'org-a' },
    enabled: true,
    source: 'server',
  });
});

test('Desktop fails closed when the server identity disagrees with account config', async () => {
  const resolve = (userId: string, orgId: string) => resolveDesktopLearningBinding({
    config: { servers: hosted, expectedUserId: userId, expectedOrgId: orgId },
    mcpClient: {
      callHostLearning: async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ userId: 'user-a', orgId: 'org-a' }) }],
      }),
    },
  });

  const [userMismatch, orgMismatch] = await Promise.all([
    resolve('user-b', 'org-a'),
    resolve('user-a', 'org-b'),
  ]);
  assert.equal(userMismatch.enabled, false);
  assert.match(userMismatch.warning ?? '', /user does not match/i);
  assert.equal(orgMismatch.enabled, false);
  assert.match(orgMismatch.warning ?? '', /organization does not match/i);
});

test('Desktop keeps separate disabled partitions when hosted identity is unavailable', async () => {
  const resolve = (apiKey: string) => resolveDesktopLearningBinding({
    config: {
      servers: { cloud: { ...hosted.cloud, apiKey } },
    },
    mcpClient: {
      callHostLearning: async () => ({ isError: true, content: [{ type: 'text' as const, text: 'offline' }] }),
    },
  });
  const [first, second] = await Promise.all([resolve('secret-a'), resolve('secret-b')]);
  assert.equal(first.enabled, false);
  assert.equal(second.enabled, false);
  assert.notEqual(first.tenant.userId, second.tenant.userId);
  assert.notEqual(first.tenant.userId, 'local');
});

test('Desktop without a BrainRouter profile remains a purely local learning profile', async () => {
  const config = {
    servers: {
      tools: { type: 'http' as const, url: 'https://tools.example/mcp', identity: 'third-party' as const },
    },
  };
  let calls = 0;
  assert.deepEqual(initialDesktopLearningBinding(config), {
    tenant: { userId: 'local', orgId: null },
    enabled: true,
    source: 'local',
  });
  assert.deepEqual(await resolveDesktopLearningBinding({
    config,
    mcpClient: { callHostLearning: async () => { calls += 1; throw new Error('must not run'); } },
  }), {
    tenant: { userId: 'local', orgId: null },
    enabled: true,
    source: 'local',
  });
  assert.equal(calls, 0);
});

test('Desktop identity classification matches URL profiles and explicit third-party overrides', async () => {
  let hostedCalls = 0;
  const hostedBinding = await resolveDesktopLearningBinding({
    config: {
      servers: { cloud: { type: 'http', url: 'https://tenant.brainrouter.cloud/mcp' } },
    },
    mcpClient: {
      callHostLearning: async () => {
        hostedCalls += 1;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ userId: 'user-cloud', orgId: 'org-cloud' }) }] };
      },
    },
  });
  assert.equal(hostedCalls, 1);
  assert.equal(hostedBinding.source, 'server');

  let thirdPartyCalls = 0;
  const localBinding = await resolveDesktopLearningBinding({
    config: {
      servers: {
        'brainrouter-shadow': {
          type: 'http', url: 'https://tenant.brainrouter.cloud/mcp', identity: 'third-party',
        },
      },
    },
    mcpClient: { callHostLearning: async () => { thirdPartyCalls += 1; throw new Error('must not run'); } },
  });
  assert.equal(thirdPartyCalls, 0);
  assert.equal(localBinding.source, 'local');
});
