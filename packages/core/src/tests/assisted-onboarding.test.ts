/**
 * assisted setup is one bounded model attempt with a
 * deterministic, no-write fallback for every unavailable or invalid outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  proposeWorkspaceOnboarding,
  type WorkspaceOnboardingModelRequest,
} from '../workspace/assistedOnboarding.js';
import { ONBOARDING_PROPOSAL_MAX_RAW_BYTES } from '../workspace/onboardingProposal.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');

function modelProposal(profile = 'engineering'): string {
  return JSON.stringify({
    profile,
    reasons: ['The bounded evidence supports this profile.'],
    persona: profile === 'engineering'
      ? { default: 'engineer', enabled: ['engineer'] }
      : { default: 'researcher', enabled: ['researcher'] },
    orchestration: profile === 'engineering'
      ? {
          mode: 'adaptive',
          availableRoles: ['explorer', 'architect', 'worker', 'reviewer', 'verifier'],
          disabledRoles: ['fleet'],
          maxParallel: 4,
        }
      : {
          mode: 'adaptive',
          availableRoles: ['explorer', 'reviewer'],
          disabledRoles: ['fleet'],
          maxParallel: 3,
        },
    capabilities: profile === 'engineering'
      ? { enabled: ['frontend'], disabled: [] }
      : { enabled: [], disabled: [] },
    skills: { packs: [profile], enabled: ['planning-skill'], disabled: [] },
    tools: { profiles: ['browser'], deny: [] },
    memory: { tags: [profile], captureHint: 'sources' },
  });
}

function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-assisted-onboarding-')));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"fixture"}\n');
  return run(workspace).finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
}

test('assisted onboarding makes one forced-tool call and returns a normalized model proposal', async () => {
  await withWorkspace(async (workspace) => {
    let calls = 0;
    let request: WorkspaceOnboardingModelRequest | undefined;
    const result = await proposeWorkspaceOnboarding({
      workspaceRoot: workspace,
      workspaceName: 'fixture',
      description: 'A source-grounded research workspace.',
      selectedInstructionPath: 'AGENT.md',
      now: () => NOW,
      complete: async (next) => {
        calls += 1;
        request = next;
        return JSON.stringify({
          ...JSON.parse(modelProposal('research')),
          instructions: { path: 'AGENT.md', contents: '# Proposed instructions\n' },
        });
      },
    });

    assert.equal(calls, 1, 'assisted setup gets exactly one logical model call');
    assert.equal(request?.tool.name, 'propose_workspace_onboarding');
    assert.deepEqual(request?.toolChoice, {
      type: 'function',
      function: { name: 'propose_workspace_onboarding' },
    });
    assert.equal(request?.maxOutputBytes, ONBOARDING_PROPOSAL_MAX_RAW_BYTES);
    assert.equal(result.modelAttempted, true);
    assert.equal(result.fallbackReason, undefined);
    assert.equal(result.proposal.source, 'model');
    assert.equal(result.proposal.manifest.profile, 'research');
    assert.equal(result.proposal.manifest.onboarded.at, NOW.toISOString());
    assert.deepEqual(result.proposal.instruction, {
      path: 'AGENT.md',
      contents: '# Proposed instructions\n',
    });
    assert.equal(fs.existsSync(path.join(workspace, 'AGENT.md')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter')), false);
  });
});

test('assisted onboarding is deterministic and no-write without a model or server bootstrap connection', async () => {
  await withWorkspace(async (workspace) => {
    const beforeEntries = fs.readdirSync(workspace, { recursive: true }).map(String).sort();
    const beforePackage = fs.readFileSync(path.join(workspace, 'package.json'), 'utf8');
    const result = await proposeWorkspaceOnboarding({
      workspaceRoot: workspace,
      now: () => NOW,
    });

    assert.equal(result.modelAttempted, false);
    assert.equal(result.fallbackReason, 'model-unavailable');
    assert.equal(result.proposal.source, 'deterministic');
    assert.equal(result.proposal.manifest.profile, 'engineering');
    assert.equal(result.proposal.manifest.persona.default, 'engineer');
    assert.equal(result.proposal.manifest.orchestration.mode, 'adaptive');
    assert.deepEqual(result.proposal.manifest.capabilities.enabled, ['frontend', 'backend']);
    assert.deepEqual(fs.readdirSync(workspace, { recursive: true }).map(String).sort(), beforeEntries);
    assert.equal(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'), beforePackage);
    assert.equal(fs.existsSync(path.join(workspace, '.brainrouter')), false);
  });
});

test('deterministic fallback derives its ordered profile from the bounded scan only', async () => {
  const cases: Array<{ profile: string; files: Record<string, string> }> = [
    { profile: 'data-science', files: { 'dvc.yaml': 'stages: {}\n' } },
    { profile: 'engineering', files: { 'package.json': '{}\n' } },
    { profile: 'research', files: { 'papers/source.md': '# Source\n' } },
    { profile: 'writing', files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' } },
    { profile: 'custom', files: { 'notes.txt': 'notes\n' } },
  ];
  for (const entry of cases) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-assisted-profile-')));
    try {
      for (const [relativePath, contents] of Object.entries(entry.files)) {
        const target = path.join(workspace, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      const result = await proposeWorkspaceOnboarding({
        workspaceRoot: workspace,
        now: () => NOW,
      });
      assert.equal(result.proposal.manifest.profile, entry.profile);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('assisted onboarding falls back after invalid, oversized, and failed model output', async () => {
  await withWorkspace(async (workspace) => {
    const cases: Array<{
      name: string;
      complete: () => Promise<string>;
      reason: 'invalid-model-output' | 'model-error';
    }> = [
      { name: 'invalid JSON', complete: async () => 'not JSON', reason: 'invalid-model-output' },
      {
        name: 'oversized output',
        complete: async () => 'x'.repeat(ONBOARDING_PROPOSAL_MAX_RAW_BYTES + 1),
        reason: 'invalid-model-output',
      },
      { name: 'provider error', complete: async () => { throw new Error('offline'); }, reason: 'model-error' },
    ];
    for (const entry of cases) {
      let calls = 0;
      const result = await proposeWorkspaceOnboarding({
        workspaceRoot: workspace,
        now: () => NOW,
        complete: async () => {
          calls += 1;
          return entry.complete();
        },
      });
      assert.equal(calls, 1, `${entry.name} must not cause a retry loop`);
      assert.equal(result.fallbackReason, entry.reason);
      assert.equal(result.proposal.source, 'deterministic');
      assert.equal(result.proposal.manifest.profile, 'engineering');
    }
  });
});

test('assisted onboarding aborts a timed-out model and returns the deterministic proposal', async () => {
  await withWorkspace(async (workspace) => {
    let signal: AbortSignal | undefined;
    const result = await proposeWorkspaceOnboarding({
      workspaceRoot: workspace,
      now: () => NOW,
      timeoutMs: 5,
      complete: async (request) => {
        signal = request.signal;
        return new Promise<string>(() => {});
      },
    });

    assert.equal(signal?.aborted, true);
    assert.equal(result.modelAttempted, true);
    assert.equal(result.fallbackReason, 'model-timeout');
    assert.equal(result.proposal.source, 'deterministic');
  });
});

test('assisted onboarding rejects an unsafe selected instruction target before model access', async () => {
  await withWorkspace(async (workspace) => {
    let called = false;
    await assert.rejects(
      proposeWorkspaceOnboarding({
        workspaceRoot: workspace,
        selectedInstructionPath: '../AGENT.md',
        complete: async () => {
          called = true;
          return modelProposal();
        },
      }),
      /Unsafe selected workspace instruction path/,
    );
    assert.equal(called, false);
  });
});

test('assisted onboarding requires an absolute host-selected workspace capability', async () => {
  await assert.rejects(
    proposeWorkspaceOnboarding({ workspaceRoot: '../not-a-workspace' }),
    /absolute host-selected workspace root/,
  );
});
