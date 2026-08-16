/**
 * ADR-027 D3 — narrow, evidenced degradation of the required-workflow gate.
 *
 * Only "the host attempted the load and it failed" degrades to a warning. That
 * is the sole case where denying wedges the agent with no recovery path, and
 * fail-closed there is a trivial self-DoS: corrupting one SKILL.md would brick
 * the agent. Every other case stays fail-closed.
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

function harness(input: {
  activation: RequiredSkillActivation;
  warned?: Set<string>;
  attempted?: Set<string>;
}): { run: () => void; notices: Array<{ level: string; message: string }> } {
  const notices: Array<{ level: string; message: string }> = [];
  const agent: any = {
    workspaceRoot: '/tmp/does-not-matter',
    sessionKey: 'k',
    accessMode: 'write',
    silent: false,
    policyAudit: [] as unknown[],
  };
  const run = (): void => {
    authorizeToolCall({
      agent,
      callbacks: {
        onStatusUpdate: () => {},
        onNotice: (n: { level: 'info' | 'warn'; message: string }) => { notices.push(n); },
      },
      name: 'write_file',
      args: { path: 'a.txt', content: 'x' },
      isLocal: true,
      skillAllowsTool: () => true,
      workspaceAllowsLocalTool: () => true,
      workspaceAllowsMcpTool: () => true,
      hardSurfaceAllowsTool: () => true,
      requiredSkillActivation: input.activation,
      loadedRequiredSkills: new Set<string>(),
      attemptedRequiredSkills: input.attempted ?? new Set<string>(['adr-skill']),
      ...(input.warned ? { warnedRequiredSkills: input.warned } : {}),
      trace: { traceId: 't', spanId: 's' },
    } as any);
  };
  return { run, notices };
}

test('a skill the host ATTEMPTED and failed to load warns once and does NOT block', () => {
  const warned = new Set<string>();
  const { run, notices } = harness({ activation: activation('available'), warned });

  assert.doesNotThrow(run, 'a corrupt SKILL.md must not brick the agent');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, 'warn');
  assert.match(notices[0].message, /could not load/);
  assert.match(notices[0].message, /adr-skill/);

  const second = harness({ activation: activation('available'), warned });
  assert.doesNotThrow(second.run);
  assert.equal(second.notices.length, 0, 'no duplicate warning within a turn');
});

test('a skill the host NEVER ATTEMPTED still blocks — no evidence it is unloadable', () => {
  const { run } = harness({
    activation: activation('available'),
    attempted: new Set<string>(),
  });
  assert.throws(run, /are not ready/);
});

test('an explicitly DISABLED skill still blocks — that is user intent', () => {
  const { run } = harness({ activation: activation('disabled') });
  assert.throws(run, /disabled for this workspace/);
});
