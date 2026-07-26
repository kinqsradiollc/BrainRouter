/** CLI coverage for deterministic proposal review and confirmation-only writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspaceManifest,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  workspaceManifestPath,
  type AssistedOnboardingResult,
  type WorkspaceOnboardingProposal,
} from '@kinqs/brainrouter-core/workspace';
import {
  formatInstructionDiff,
  runProjectOnboardingAgent,
  runProjectOnboardingScan,
} from '../cli/commands/init/projectOnboardingScan.js';
import type {
  ProjectOnboardingPrompt,
  ProjectOnboardingPromptId,
} from '../cli/commands/init/projectOnboard.js';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboarding-scan-'));
}

function reviewingPrompt(options: {
  cancelAt?: ProjectOnboardingPromptId;
  instruction?: 'apply' | 'keep';
  beforeConfirm?: () => void;
} = {}): ProjectOnboardingPrompt {
  return async (request) => {
    if (request.id === options.cancelAt) return { kind: 'cancel' };
    if (request.id === 'start') return { kind: 'submit', value: 'continue' };
    if (request.id === 'profile') return { kind: 'submit', value: request.initialChoice ?? 'engineering' };
    if (request.id === 'orchestration-mode') {
      return { kind: 'submit', value: request.initialChoice ?? 'off' };
    }
    if (request.id === 'instruction-change') {
      return { kind: 'submit', value: options.instruction ?? 'apply' };
    }
    if (request.id === 'confirm') {
      options.beforeConfirm?.();
      return { kind: 'submit', value: 'save' };
    }
    return { kind: 'submit', value: request.initialValue ?? '' };
  };
}

function resultFor(proposal: WorkspaceOnboardingProposal): AssistedOnboardingResult {
  return {
    proposal,
    modelAttempted: proposal.source === 'model',
    scan: {
      markers: ['package.json'],
      directories: [],
      files: [],
      stats: {
        entriesVisited: 1,
        directoriesVisited: 0,
        filesRead: 1,
        bytesRead: 2,
        ignoredEntries: 0,
        unreadableEntries: 0,
      },
      stoppedBy: [],
    },
  };
}

function modelProposal(): string {
  return JSON.stringify({
    profile: 'engineering',
    reasons: ['The project description and bounded repository evidence indicate a web application.'],
    persona: { default: 'engineer', enabled: ['engineer'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'architect', 'worker', 'reviewer', 'verifier'],
      disabledRoles: ['fleet'],
      maxParallel: 4,
    },
    capabilities: { enabled: ['frontend'], disabled: [] },
    skills: { packs: ['engineering'], enabled: ['frontend-design'], disabled: [] },
    tools: { profiles: ['browser'], deny: [] },
    memory: { tags: ['customer-portal'], captureHint: 'Capture product and architecture decisions.' },
  });
}

test('deterministic scan reviews a complete proposal before creating the manifest', async () => {
  const root = makeWorkspace();
  const output: string[] = [];
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"ui"}\n');
    const result = await runProjectOnboardingScan(root, {
      prompt: reviewingPrompt(),
      print: (message) => output.push(message),
    });
    assert.equal(result.status, 'committed');
    const saved = loadWorkspaceManifest(root);
    assert.ok(saved);
    assert.equal(saved.persona.default, 'engineer');
    assert.deepEqual(saved.persona.enabled, ['engineer']);
    assert.equal(saved.orchestration.mode, 'adaptive');
    assert.deepEqual(saved.capabilities.enabled, ['frontend']);
    assert.equal(fs.existsSync(path.join(root, 'AGENT.md')), false);
    assert.ok(output.some((message) => message.includes('Workspace scan')));
    assert.ok(output.some((message) => message.includes('tool profiles')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assisted initializer makes one bounded proposal call and reviews the model result', async () => {
  const root = makeWorkspace();
  const output: string[] = [];
  let calls = 0;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"portal"}\n');
    const result = await runProjectOnboardingAgent(
      root,
      { provider: 'openai', model: 'managed-model', apiKey: 'secret', endpoint: 'https://example.invalid' },
      'Build a responsive customer portal',
      {
        complete: async (request) => {
          calls += 1;
          assert.match(request.user, /Build a responsive customer portal/);
          assert.equal(request.toolChoice.function.name, 'propose_workspace_onboarding');
          return modelProposal();
        },
        prompt: reviewingPrompt(),
        print: (message) => output.push(message),
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, 'committed');
    assert.equal(loadWorkspaceManifest(root)?.persona.default, 'engineer');
    assert.deepEqual(loadWorkspaceManifest(root)?.capabilities.enabled, ['frontend']);
    assert.ok(output.some((message) => message.includes('Proposal source') && message.includes('managed model')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assisted initializer safely labels a model failure and reviews the deterministic fallback', async () => {
  const root = makeWorkspace();
  const output: string[] = [];
  let calls = 0;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const result = await runProjectOnboardingAgent(
      root,
      { provider: 'openai', model: 'managed-model', apiKey: 'secret', endpoint: 'https://example.invalid' },
      undefined,
      {
        complete: async () => {
          calls += 1;
          throw new Error('provider failed with OPENAI_API_KEY=sk-do-not-print');
        },
        prompt: reviewingPrompt(),
        print: (message) => output.push(message),
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, 'committed');
    assert.equal(loadWorkspaceManifest(root)?.persona.default, 'engineer');
    assert.ok(output.some((message) => message.includes('deterministic fallback (model request failed)')));
    assert.equal(output.some((message) => message.includes('sk-do-not-print')), false);
    assert.equal(output.some((message) => message.includes('OPENAI_API_KEY')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assisted initializer labels invalid model output without exposing it', async () => {
  const root = makeWorkspace();
  const output: string[] = [];
  try {
    const result = await runProjectOnboardingAgent(
      root,
      { provider: 'openai', model: 'managed-model', apiKey: '', endpoint: 'https://example.invalid' },
      'A documentation workspace',
      {
        complete: async () => 'invalid-response-with-private-provider-detail',
        prompt: reviewingPrompt(),
        print: (message) => output.push(message),
      },
    );
    assert.equal(result.status, 'committed');
    assert.ok(output.some((message) => message.includes('deterministic fallback (model response was invalid)')));
    assert.equal(output.some((message) => message.includes('private-provider-detail')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling proposal review writes nothing', async () => {
  const root = makeWorkspace();
  try {
    const result = await runProjectOnboardingScan(root, {
      prompt: reviewingPrompt({ cancelAt: 'capabilities-enabled' }),
      print: () => undefined,
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(fs.existsSync(workspaceManifestPath(root)), false);
    assert.equal(fs.existsSync(path.join(root, 'AGENT.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepted instruction diff commits AGENT.md with the reviewed manifest', async () => {
  const root = makeWorkspace();
  const output: string[] = [];
  fs.writeFileSync(path.join(root, 'AGENT.md'), '# Old\n');
  const manifest = createWorkspaceManifest({
    name: 'reviewed',
    profile: 'engineering',
    by: 'agent',
    at: '2026-01-02T03:04:05.000Z',
  });
  try {
    const result = await runProjectOnboardingScan(root, {
      propose: async () => resultFor({
        source: 'model',
        manifest,
        reasons: ['The repository contains an application UI.'],
        instruction: { path: 'AGENT.md', contents: '# New\n' },
      }),
      prompt: reviewingPrompt({ instruction: 'apply' }),
      print: (message) => output.push(message),
    });
    assert.equal(result.status, 'committed');
    assert.equal(fs.readFileSync(path.join(root, 'AGENT.md'), 'utf8'), '# New\n');
    const diff = output.find((message) => message.includes('--- a/AGENT.md')) ?? '';
    assert.match(diff, /-# Old/);
    assert.match(diff, /\+# New/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejected instruction diff keeps AGENT.md and saves only the manifest', async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, 'AGENT.md'), '# Keep\n');
  const manifest = createWorkspaceManifest({ name: 'reviewed', profile: 'research', by: 'agent' });
  try {
    const result = await runProjectOnboardingScan(root, {
      propose: async () => resultFor({
        source: 'model',
        manifest,
        reasons: ['Research markers were detected.'],
        instruction: { path: 'AGENT.md', contents: '# Replace\n' },
      }),
      prompt: reviewingPrompt({ instruction: 'keep' }),
      print: () => undefined,
    });
    assert.equal(result.status, 'committed');
    assert.equal(fs.readFileSync(path.join(root, 'AGENT.md'), 'utf8'), '# Keep\n');
    assert.equal(loadWorkspaceManifest(root)?.profile, 'research');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a concurrent change rejects the stale scanned proposal without overwriting it', async () => {
  const root = makeWorkspace();
  const external = createWorkspaceManifest({ name: 'external', profile: 'writing', by: 'import' });
  try {
    await assert.rejects(
      runProjectOnboardingScan(root, {
        prompt: reviewingPrompt({ beforeConfirm: () => saveWorkspaceManifest(root, external) }),
        print: () => undefined,
      }),
      /changed during review|changed during the scan/i,
    );
    assert.equal(loadWorkspaceManifest(root)?.name, 'external');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable manifest is never replaced by scan onboarding', async () => {
  const root = makeWorkspace();
  const target = workspaceManifestPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{not-json', 'utf8');
  try {
    await assert.rejects(
      runProjectOnboardingScan(root, { prompt: reviewingPrompt(), print: () => undefined }),
      /exists but cannot be read safely/i,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '{not-json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scan updates preserve existing workspace identity and safe forward fields', async () => {
  const root = makeWorkspace();
  const existing = {
    ...createWorkspaceManifest({
      name: 'durable-name',
      profile: 'writing',
      by: 'import',
      at: '2025-01-02T03:04:05.000Z',
    }),
    extra: { future: { enabled: true } },
  };
  saveWorkspaceManifest(root, existing);
  try {
    const result = await runProjectOnboardingScan(root, {
      prompt: reviewingPrompt(),
      print: () => undefined,
    });
    assert.equal(result.status, 'committed');
    const saved = loadWorkspaceManifest(root);
    assert.ok(saved);
    assert.equal(saved.name, 'durable-name');
    assert.deepEqual(saved.onboarded, existing.onboarded);
    assert.deepEqual(saved.extra, existing.extra);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('instruction diff bounds newline-dense input and still shows every replacement line', () => {
  const original = Array.from({ length: 600 }, (_, index) => `old-${index}`).join('\n');
  const proposed = Array.from({ length: 600 }, (_, index) => `new-${index}`).join('\n');
  const diff = formatInstructionDiff(original, proposed);
  assert.match(diff, /^--- a\/AGENT\.md\n\+\+\+ b\/AGENT\.md\n-old-0/m);
  assert.match(diff, /-old-599/);
  assert.match(diff, /\+new-599/);
});
