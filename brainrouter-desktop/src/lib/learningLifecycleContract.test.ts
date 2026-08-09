import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('desktop learned-behaviour revert uses the pinned tenant and host-only central lifecycle RPC', () => {
  const hostQueries = read('../../electron/host/queries.ts');
  const settings = read('../../src/settings.tsx');
  const results = read('./agent/useAgentEvents/handleQueryResult.ts');

  assert.match(hostQueries, /'action:learning-revert':/);
  assert.match(hostQueries, /'action:learning-revert':[\s\S]{0,300}learnedTenantForAgent\(getActiveAgent\(\)\)/);
  assert.match(hostQueries, /'action:learning-revert':[\s\S]{0,800}revertLearnedItemLifecycle\(/);
  assert.match(hostQueries, /callHostLearning\(\{[\s\S]{0,100}operation: 'revert'/);
  assert.doesNotMatch(hostQueries, /callTool\([^\n]*memory_learned_revert/);

  assert.match(settings, /onAction\('a-learning-revert',\s*'action:learning-revert'/);
  assert.doesNotMatch(settings, /a-learning-revert'[\s\S]{0,160}setTimeout/);
  assert.match(results, /case 'a-learning-revert':[\s\S]{0,250}q\('q-snapshot',\s*'config-snapshot'\)/);
  assert.match(results, /central-memory archive is pending/);
});

test('desktop boot and credential rebind pin learning only from the custom identity channel', () => {
  const host = read('../../electron/host.ts');
  const hostQueries = read('../../electron/host/queries.ts');
  const identity = read('../../electron/host/learningIdentity.ts');

  assert.match(host, /initialDesktopLearningBinding\(desktopLearningIdentityConfig\(config\)\)/);
  assert.match(host, /\.then\(\(\) => resolveLearningIdentity\(config\)\)/);
  assert.match(host, /void mcpReady[\s\S]{0,400}core\.bindLearning\(/);
  assert.match(host, /resolved\.source === 'server'[\s\S]{0,220}boundBrainOrgId = resolved\.tenant\.orgId/);
  assert.match(identity, /callHostLearning\(\{ operation: 'identity' \}\)/);
  assert.doesNotMatch(identity, /callTool\(/);

  const rebindAt = host.indexOf('await core.rebindTenant');
  const connectAt = host.indexOf('await mcpClient.connectOne', rebindAt);
  const identityAt = host.indexOf('await resolveLearningIdentity(reboundConfig)', connectAt);
  const respawnAt = host.indexOf('return spawnAgent(sessionKey)', identityAt);
  assert.ok(rebindAt >= 0 && connectAt > rebindAt && identityAt > connectAt && respawnAt > identityAt);

  const reconnectAt = hostQueries.indexOf("'action:reconnect-mcp':");
  const activeServerAt = hostQueries.indexOf("'action:set-active-server':", reconnectAt);
  const addServerAt = hostQueries.indexOf("'action:add-mcp':", activeServerAt);
  const removeServerAt = hostQueries.indexOf("'action:remove-mcp':", addServerAt);
  const signinAt = hostQueries.indexOf("'action:auth-signin':");
  const signoutAt = hostQueries.indexOf("'action:auth-signout':", signinAt);
  const authStatusAt = hostQueries.indexOf("'auth-status':", signoutAt);
  const reconnectIdentityAt = hostQueries.indexOf('forceIdentity: true', reconnectAt);
  const signinRebindAt = hostQueries.indexOf('rebindActiveAccountOrg(', signinAt);
  const signoutRebindAt = hostQueries.indexOf('rebindActiveAccountOrg(', signoutAt);
  assert.ok(reconnectAt >= 0 && reconnectIdentityAt > reconnectAt && reconnectIdentityAt < activeServerAt);
  assert.match(hostQueries.slice(addServerAt, removeServerAt), /rebindActiveAccountOrg\([\s\S]*forceIdentity: true/);
  assert.match(hostQueries.slice(removeServerAt, signinAt), /rebindActiveAccountOrg\([\s\S]*forceIdentity: true/);
  assert.ok(signinRebindAt > signinAt && signinRebindAt < signoutAt);
  assert.match(hostQueries.slice(signinRebindAt, signinRebindAt + 200), /forceIdentity: true/);
  assert.ok(signoutRebindAt > signoutAt && signoutRebindAt < authStatusAt);
  assert.match(hostQueries.slice(signoutRebindAt, signoutRebindAt + 200), /forceIdentity: true/);
});

test('desktop clear pins one Agent and awaits its idempotent session-end drain before clearing history', () => {
  const hostQueries = read('../../electron/host/queries.ts');
  const learningPhase = read('../../../packages/core/src/agent/runtime/learningPhase.ts');
  const clearBlock = hostQueries.slice(
    hostQueries.indexOf("'action:clear':"),
    hostQueries.indexOf("'action:rewind-to':"),
  );

  const pinAt = clearBlock.indexOf('const activeAgent = getActiveAgent()');
  const drainAt = clearBlock.indexOf('await activeAgent.endSession()', pinAt);
  const clearAt = clearBlock.indexOf('activeAgent.clearHistory()', drainAt);
  assert.ok(pinAt >= 0 && drainAt > pinAt && clearAt > drainAt);
  assert.doesNotMatch(clearBlock, /await getActiveAgent\(\)\.endSession[\s\S]*getActiveAgent\(\)\.clearHistory/);

  // The awaited Agent boundary itself coalesces repeated closes for the same
  // logical session, so duplicate clear actions cannot run duplicate final
  // checkpoints while the first one is pending or after it completes.
  assert.match(learningPhase, /const endingSessions = new WeakMap/);
  assert.match(learningPhase, /const existing = bySession\.get\(sessionKey\);[\s\S]{0,80}if \(existing\) return existing/);
});
