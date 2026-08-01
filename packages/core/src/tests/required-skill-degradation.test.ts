/**
 * ADR-027 D3 — the required-workflow gate is FAIL-CLOSED.
 *
 * The ADR proposed degrading an unresolvable required skill to a warning so a
 * missing workflow could not deadlock the agent. Security review rejected that
 * twice (CWE-863): a skill load failure is attacker-influenceable, and 0.4.18's
 * auto-loading preflight already resolves the common deadlock. These tests lock
 * the fail-closed property in so it cannot regress silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeToolCall } from '../agent/runtime/toolAuthorizationPhase.js';
import type { RequiredSkillActivation } from '../workspace/requiredSkillActivation.js';

function activation(availability: 'available' | 'disabled'): RequiredSkillActivation {
  return {
    planningSchema: { id: 'default', label: 'Default', source: 'profile-default' },
    required: [{ id: 'adr-skill', reason: 'test', availability }],
  };
}

function run(input: {
  activation: RequiredSkillActivation;
  attempted?: Set<string>;
}): void {
  const agent: any = {
    workspaceRoot: '/tmp/does-not-matter',
    sessionKey: 'k',
    accessMode: 'write',
    silent: false,
    policyAudit: [] as unknown[],
  };
  authorizeToolCall({
    agent,
    callbacks: { onStatusUpdate: () => {}, onNotice: () => {} } as any,
    name: 'write_file',
    args: { path: 'a.txt', content: 'x' },
    isLocal: true,
    skillAllowsTool: () => true,
    workspaceAllowsLocalTool: () => true,
    workspaceAllowsMcpTool: () => true,
    requiredSkillActivation: input.activation,
    loadedRequiredSkills: new Set<string>(),
    attemptedRequiredSkills: input.attempted ?? new Set<string>(['adr-skill']),
    trace: { traceId: 't', spanId: 's' },
  } as any);
}

test('a required skill the host ATTEMPTED and failed to load still blocks the mutation', () => {
  assert.throws(
    () => run({ activation: activation('available') }),
    /could not be loaded by the host/,
    'a load failure must not open the gate — it is attacker-influenceable',
  );
});

test('a required skill the host never attempted still blocks the mutation', () => {
  assert.throws(
    () => run({ activation: activation('available'), attempted: new Set<string>() }),
    /are not ready/,
  );
});

test('an explicitly disabled required skill blocks with a distinct reason', () => {
  assert.throws(() => run({ activation: activation('disabled') }), /disabled for this workspace/);
});
