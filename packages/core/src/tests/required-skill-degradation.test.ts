/**
 * ADR-027 D3 — an UNRESOLVABLE required workflow skill must not deadlock the
 * agent. It degrades to a single warning and the mutation proceeds. Explicitly
 * DISABLING a skill is user intent and still blocks.
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
    // authorizeToolCall records an audit row for every mutating call.
    policyAudit: [] as unknown[],
  };
  const callbacks: any = {
    onStatusUpdate: () => {},
    onNotice: (n: { level: 'info' | 'warn'; message: string }) => { notices.push(n); },
  };
  const run = (): void => {
    authorizeToolCall({
      agent,
      callbacks,
      name: 'write_file',
      args: { path: 'a.txt', content: 'x' },
      isLocal: true,
      skillAllowsTool: () => true,
      workspaceAllowsLocalTool: () => true,
      workspaceAllowsMcpTool: () => true,
      requiredSkillActivation: input.activation,
      loadedRequiredSkills: new Set<string>(),
      attemptedRequiredSkills: input.attempted ?? new Set<string>(['adr-skill']),
      ...(input.warned ? { warnedRequiredSkills: input.warned } : {}),
      trace: { traceId: 't', spanId: 's' },
    } as any);
  };
  return { run, notices };
}

test('a required skill the host NEVER ATTEMPTED still blocks — no evidence it is unloadable', () => {
  // The preflight-race / precondition case. Degrading here would relax the gate
  // without any evidence that loading actually failed.
  const { run } = harness({
    activation: activation('available'),
    attempted: new Set<string>(),
  });
  assert.throws(run, /are not ready/);
});

test('a required skill the host ATTEMPTED and failed to load warns once and does NOT block', () => {
  const warned = new Set<string>();
  const { run, notices } = harness({ activation: activation('available'), warned });

  assert.doesNotThrow(run, 'a missing workflow must never deadlock the agent');
  assert.equal(notices.length, 1, 'exactly one warning');
  assert.equal(notices[0].level, 'warn');
  assert.match(notices[0].message, /Proceeding without required workflow skill/);
  assert.match(notices[0].message, /adr-skill/);

  // A second mutating call in the same turn must not re-warn — repeated notices
  // train the user to ignore them.
  const second = harness({ activation: activation('available'), warned });
  assert.doesNotThrow(second.run);
  assert.equal(second.notices.length, 0, 'no duplicate warning within a turn');
});

test('an explicitly DISABLED required skill still blocks — that is user intent', () => {
  const { run } = harness({ activation: activation('disabled') });
  assert.throws(run, /disabled for this workspace/);
});

test('warning is emitted even when no dedupe set is supplied', () => {
  const { run, notices } = harness({ activation: activation('available') });
  assert.doesNotThrow(run);
  assert.equal(notices.length, 1);
});
