/**
 * Project onboarding helpers, collect/review/commit lifecycle,
 * cancellation guarantees, edit round-trips, and cross-file rollback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspaceManifest,
  isWorkspaceOnboarded,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  workspaceManifestPath,
} from '@kinqs/brainrouter-core/workspace';
import {
  _setProjectOnboardingFilesystemHookForTests,
  _setProjectOnboardingTransactionHookForTests,
  commitProjectOnboarding,
  formatManifestSummary,
  parseSelectionList,
  resolveProfileAnswer,
  runProjectOnboarding,
  suggestWorkspaceProfile,
  type ProjectOnboardingPersistence,
  type ProjectOnboardingPrompt,
  type ProjectOnboardingPromptId,
  type ProjectOnboardingPromptRequest,
  type ProjectOnboardingPromptResponse,
} from '../cli/commands/init/projectOnboard.js';

test('project onboarding mutation hooks reject non-test runtimes', () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.throws(
      () => _setProjectOnboardingFilesystemHookForTests(() => undefined),
      /unavailable outside a test runtime/,
    );
    assert.throws(
      () => _setProjectOnboardingTransactionHookForTests(() => undefined),
      /unavailable outside a test runtime/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('project onboarding mutation hooks re-check the test runtime when invoked', () => {
  const ws = makeWorkspace({});
  const manifest = createWorkspaceManifest({
    name: 'guarded-hook',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const previous = process.env.NODE_TEST_CONTEXT;
  let hookCalls = 0;
  _setProjectOnboardingFilesystemHookForTests(() => { hookCalls += 1; });
  delete process.env.NODE_TEST_CONTEXT;

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, manifest, false),
      /unavailable outside a test runtime/,
    );
    assert.equal(hookCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

const projectOnboardingTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboard-home-'));
const previousBrainrouterHome = process.env.BRAINROUTER_HOME;
process.env.BRAINROUTER_HOME = projectOnboardingTestHome;
test.after(() => {
  if (previousBrainrouterHome === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = previousBrainrouterHome;
  fs.rmSync(projectOnboardingTestHome, { recursive: true, force: true });
});

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-onboard-'));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return root;
}

const DEFAULT_SUBMISSIONS: Record<ProjectOnboardingPromptId, string> = {
  'start': 'continue',
  'profile': 'custom',
  'agent-default': '',
  'agents-enabled': '',
  'capabilities-enabled': '',
  'capabilities-disabled': '',
  'skill-packs': '',
  'skills-enabled': '',
  'skills-disabled': '',
  'tool-profiles': '',
  'tools-deny': '',
  'agent-md': 'write',
  'confirm': 'save',
};

const FRESH_PROMPT_IDS = Object.keys(DEFAULT_SUBMISSIONS) as ProjectOnboardingPromptId[];

function submitFor(
  request: ProjectOnboardingPromptRequest,
  overrides: Partial<Record<ProjectOnboardingPromptId, string>> = {},
): ProjectOnboardingPromptResponse {
  return {
    kind: 'submit',
    value: overrides[request.id]
      ?? (request.kind === 'text' ? request.initialValue : undefined)
      ?? DEFAULT_SUBMISSIONS[request.id],
  };
}

function assertProjectFilesAbsent(workspace: string): void {
  assert.equal(fs.existsSync(workspaceManifestPath(workspace)), false, 'workspace manifest must not exist');
  assert.equal(fs.existsSync(path.join(workspace, 'AGENT.md')), false, 'AGENT.md must not exist');
}

function listWorkspaceOnboardingReceipts(): Set<string> {
  const root = path.join(projectOnboardingTestHome, 'transactions', 'workspace-onboarding');
  const receipts = new Set<string>();
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.json')) receipts.add(candidate);
    }
  };
  visit(root);
  return receipts;
}

function listWorkspaceManifestClaimReceipts(): Set<string> {
  const root = path.join(projectOnboardingTestHome, 'transactions', 'workspace-manifest');
  const receipts = new Set<string>();
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.json')) receipts.add(candidate);
    }
  };
  visit(root);
  return receipts;
}

function filesystemPersistence(events: string[] = []): ProjectOnboardingPersistence {
  return {
    saveManifest(workspaceRoot, manifest) {
      events.push('save-manifest');
      return saveWorkspaceManifest(workspaceRoot, manifest);
    },
    initInstructions(workspaceRoot) {
      events.push('write-agent-md');
      const target = path.join(workspaceRoot, 'AGENT.md');
      fs.writeFileSync(target, '# Project instructions\n', 'utf8');
      return { status: 'created', path: target };
    },
  };
}

test('suggestWorkspaceProfile: notebooks → data-science (beats code markers)', () => {
  const ws = makeWorkspace({ 'analysis.ipynb': '{}', 'package.json': '{}' });
  try {
    assert.equal(suggestWorkspaceProfile(ws).profile, 'data-science');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('suggestWorkspaceProfile: build manifests → engineering, with reasons', () => {
  const ws = makeWorkspace({ 'package.json': '{}', 'tsconfig.json': '{}' });
  try {
    const suggestion = suggestWorkspaceProfile(ws);
    assert.equal(suggestion.profile, 'engineering');
    assert.ok(suggestion.reasons.some((reason) => reason.includes('package.json')));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('suggestWorkspaceProfile: bibliography → research; md-dominant → writing; empty → custom', () => {
  const research = makeWorkspace({ 'refs.bib': '@article{}' });
  const writing = makeWorkspace({ 'ch1.md': '#', 'ch2.md': '#', 'ch3.md': '#' });
  const empty = makeWorkspace({});
  try {
    assert.equal(suggestWorkspaceProfile(research).profile, 'research');
    assert.equal(suggestWorkspaceProfile(writing).profile, 'writing');
    assert.equal(suggestWorkspaceProfile(empty).profile, 'custom');
  } finally {
    for (const ws of [research, writing, empty]) fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('suggestWorkspaceProfile never throws on an unreadable root', () => {
  assert.equal(suggestWorkspaceProfile('/definitely/not/a/real/path-xyz').profile, 'custom');
});

test('resolveProfileAnswer: empty → suggested; index, id, and unique prefix all resolve', () => {
  assert.equal(resolveProfileAnswer('', 'research'), 'research');
  assert.equal(resolveProfileAnswer('1', 'custom'), 'engineering');
  assert.equal(resolveProfileAnswer('study', 'custom'), 'study');
  assert.equal(resolveProfileAnswer('eng', 'custom'), 'engineering');
  assert.equal(resolveProfileAnswer('data', 'custom'), 'data-science');
});

test('resolveProfileAnswer: garbage and out-of-range → null (wizard re-asks)', () => {
  assert.equal(resolveProfileAnswer('99', 'custom'), null);
  assert.equal(resolveProfileAnswer('0', 'custom'), null);
  assert.equal(resolveProfileAnswer('zzz', 'custom'), null);
});

test('parseSelectionList trims, removes empties, and de-duplicates while preserving order', () => {
  assert.deepEqual(
    parseSelectionList(' engineer, frontend, engineer, , frontend , Research, research '),
    ['engineer', 'frontend', 'Research', 'research'],
  );
  assert.deepEqual(parseSelectionList(' , , '), []);
});

test('formatManifestSummary includes profile, engineer capability, and edit pointer', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard', at: '2026-07-21T00:00:00Z' });
  const summary = formatManifestSummary(manifest);
  assert.ok(summary.includes('demo'));
  assert.ok(summary.includes('engineering'));
  assert.ok(summary.includes('engineer'));
  assert.ok(summary.includes('capabilities: frontend'));
  assert.ok(!summary.includes('frontend-builder'));
  assert.ok(summary.includes('/init --edit'));
});

test('formatManifestSummary cannot emit controls from an unnormalized manifest object', () => {
  const manifest = createWorkspaceManifest({ name: 'demo', profile: 'engineering', by: 'wizard' });
  manifest.name = 'demo\u001b[31m\nforged';
  manifest.agents.enabled.push('reviewer\u009b31m');
  const summary = formatManifestSummary(manifest);
  assert.equal(summary.split('\n').length, 10, 'embedded newlines cannot forge extra summary rows');
  assert.equal(summary.includes('\u001b[31m'), false);
  assert.equal(summary.includes('\u009b'), false);
  assert.ok(summary.includes('demo[31mforged'));
});

test('project onboarding Skip writes neither manifest nor AGENT.md', async () => {
  const ws = makeWorkspace({});
  const printed: string[] = [];
  let persistenceCalls = 0;
  try {
    const result = await runProjectOnboarding(ws, {
      prompt: async (request) => {
        assert.equal(request.id, 'start');
        return { kind: 'skip' };
      },
      print: (message) => printed.push(message),
      persistence: {
        saveManifest() {
          persistenceCalls += 1;
          throw new Error('saveManifest must not run after Skip');
        },
        initInstructions() {
          persistenceCalls += 1;
          throw new Error('initInstructions must not run after Skip');
        },
      },
    });

    assert.equal(result.status, 'skipped');
    assert.equal(persistenceCalls, 0);
    assertProjectFilesAbsent(ws);
    assert.ok(printed.some((message) => message.includes('no project files written')));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('project onboarding preserves an unreadable manifest instead of treating it as absent', async () => {
  const corruptBytes = Buffer.from('{"profile":"engineering",not-json\n');
  const ws = makeWorkspace({ '.brainrouter/workspace.json': corruptBytes.toString('utf8') });
  let promptCalls = 0;
  let persistenceCalls = 0;
  try {
    await assert.rejects(
      runProjectOnboarding(ws, {
        prompt: async () => {
          promptCalls += 1;
          return { kind: 'cancel' };
        },
        print: () => {},
        persistence: {
          saveManifest() {
            persistenceCalls += 1;
            throw new Error('an unreadable manifest must never be overwritten');
          },
          initInstructions() {
            persistenceCalls += 1;
            throw new Error('an unreadable manifest must never create instructions');
          },
        },
      }),
      /Workspace manifest exists but cannot be read safely\. Back it up and repair or remove/,
    );

    assert.equal(promptCalls, 0, 'repair is required before onboarding can start');
    assert.equal(persistenceCalls, 0);
    assert.deepEqual(fs.readFileSync(workspaceManifestPath(ws)), corruptBytes);
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('successful review writes manifest and AGENT.md only after final confirmation', async () => {
  const ws = makeWorkspace({ 'package.json': '{"name":"demo"}' });
  const events: string[] = [];
  const seen: ProjectOnboardingPromptId[] = [];
  const overrides: Partial<Record<ProjectOnboardingPromptId, string>> = {
    'profile': 'engineering',
    'agent-default': 'engineer',
    'agents-enabled': 'engineer, researcher, engineer',
    'capabilities-enabled': 'frontend, docs',
    'capabilities-disabled': 'docs',
    'skill-packs': 'engineering, ui',
    'skills-enabled': 'testing-skill, ui-skill',
    'skills-disabled': 'ui-skill',
    'tool-profiles': 'coding, browser',
    'tools-deny': 'dangerous-tool',
    'agent-md': 'write',
  };
  try {
    const prompt: ProjectOnboardingPrompt = async (request) => {
      events.push(`prompt:${request.id}`);
      seen.push(request.id);
      assertProjectFilesAbsent(ws);
      return submitFor(request, overrides);
    };
    const result = await runProjectOnboarding(ws, {
      prompt,
      print: (message) => events.push(`print:${message.includes('Review workspace setup') ? 'review' : 'other'}`),
      persistence: filesystemPersistence(events),
      now: () => '2026-07-21T12:00:00.000Z',
    });

    assert.equal(result.status, 'committed');
    assert.deepEqual(seen, FRESH_PROMPT_IDS, 'the full create flow must reach every review prompt in order');
    assert.deepEqual(
      events.filter((event) => event === 'prompt:confirm' || event === 'save-manifest' || event === 'write-agent-md'),
      ['prompt:confirm', 'write-agent-md', 'save-manifest'],
      'both writes must occur only after the final confirmation',
    );
    assert.equal(fs.existsSync(workspaceManifestPath(ws)), true);
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), '# Project instructions\n');

    const saved = loadWorkspaceManifest(ws);
    assert.ok(saved);
    assert.equal(saved.onboarded.at, '2026-07-21T12:00:00.000Z');
    assert.deepEqual(saved.agents, { default: 'engineer', enabled: ['engineer', 'researcher'] });
    assert.deepEqual(saved.capabilities, { enabled: ['frontend'], disabled: ['docs'] });
    assert.deepEqual(saved.skills, {
      packs: ['engineering', 'ui'],
      enabled: ['testing-skill'],
      disabled: ['ui-skill'],
    });
    assert.deepEqual(saved.tools, { profiles: ['coding', 'browser'], deny: ['dangerous-tool'] });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('review, result, and disk all use the same secret-sanitized manifest', async () => {
  const ws = makeWorkspace({});
  const printed: string[] = [];
  try {
    const result = await runProjectOnboarding(ws, {
      prompt: async (request) => submitFor(request, {
        'profile': 'custom',
        'agent-default': 'sk-secretvalue123456',
        'agents-enabled': 'engineer, sk-secretvalue123456',
        'capabilities-enabled': 'frontend, /Users/example/private-capability',
        'agent-md': 'keep',
      }),
      print: (message) => printed.push(message),
    });

    assert.equal(result.status, 'committed');
    assert.equal(printed.join('\n').includes('sk-secretvalue123456'), false);
    assert.equal(printed.join('\n').includes('/Users/example'), false);
    assert.deepEqual(result.manifest, loadWorkspaceManifest(ws));
    assert.deepEqual(result.manifest.agents, { default: '', enabled: ['engineer'] });
    assert.deepEqual(result.manifest.capabilities, { enabled: ['frontend'], disabled: [] });
    assert.equal(result.manifest.instructions, '');
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('cancellation at every reachable fresh-workspace prompt leaves project files absent', async (t) => {
  for (const cancelAt of FRESH_PROMPT_IDS) {
    await t.test(cancelAt, async () => {
      const ws = makeWorkspace({});
      const seen: ProjectOnboardingPromptId[] = [];
      let persistenceCalls = 0;
      try {
        const result = await runProjectOnboarding(ws, {
          prompt: async (request) => {
            seen.push(request.id);
            return request.id === cancelAt ? { kind: 'cancel' } : submitFor(request);
          },
          print: () => {},
          persistence: {
            saveManifest() {
              persistenceCalls += 1;
              throw new Error('saveManifest must not run after cancellation');
            },
            initInstructions() {
              persistenceCalls += 1;
              throw new Error('initInstructions must not run after cancellation');
            },
          },
        });

        assert.equal(result.status, 'cancelled');
        assert.equal(seen.at(-1), cancelAt, 'the requested cancellation point must be reached');
        assert.equal(persistenceCalls, 0);
        assertProjectFilesAbsent(ws);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }
});

test('/init --edit preserves future version, safe unknown fields, and a custom instruction pointer', async () => {
  const ws = makeWorkspace({
    'AGENT.md': '# Root instructions must not replace the pointer\n',
    'docs/PROJECT_AI.md': '# Existing custom instructions\n',
  });
  const seed = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  seed.version = 2;
  seed.instructions = 'docs/PROJECT_AI.md';
  seed.extra = { futureField: { keep: true, revision: 3 } };
  saveWorkspaceManifest(ws, seed);
  let instructionCalls = 0;
  const seen: ProjectOnboardingPromptId[] = [];
  const edits: Partial<Record<ProjectOnboardingPromptId, string>> = {
    'profile': 'research',
    'agent-default': 'researcher',
    'agents-enabled': 'researcher, analyst',
    'capabilities-enabled': 'citations',
    'capabilities-disabled': 'frontend',
    'skill-packs': 'research, shared',
    'skills-enabled': 'planning-skill, handover-skill',
    'skills-disabled': 'legacy-skill',
    'tool-profiles': 'browser, notes',
    'tools-deny': 'shell',
  };
  try {
    const result = await runProjectOnboarding(ws, {
      edit: true,
      prompt: async (request) => {
        seen.push(request.id);
        return submitFor(request, edits);
      },
      print: () => {},
      persistence: {
        saveManifest: saveWorkspaceManifest,
        initInstructions() {
          instructionCalls += 1;
          throw new Error('existing instructions must not be rewritten');
        },
      },
    });

    assert.equal(result.status, 'committed');
    assert.equal(instructionCalls, 0);
    assert.equal(seen.includes('agent-md'), false, 'existing instruction files suppress the scaffold prompt');
    const saved = loadWorkspaceManifest(ws);
    assert.ok(saved);
    assert.equal(saved.version, 2);
    assert.equal(saved.profile, 'research');
    assert.deepEqual(saved.agents, { default: 'researcher', enabled: ['researcher', 'analyst'] });
    assert.deepEqual(saved.capabilities, { enabled: ['citations'], disabled: ['frontend'] });
    assert.deepEqual(saved.skills, {
      packs: ['research', 'shared'],
      enabled: ['planning-skill', 'handover-skill'],
      disabled: ['legacy-skill'],
    });
    assert.deepEqual(saved.tools, { profiles: ['browser', 'notes'], deny: ['shell'] });
    assert.deepEqual(saved.extra, { futureField: { keep: true, revision: 3 } });
    assert.equal(saved.instructions, 'docs/PROJECT_AI.md');
    assert.equal(saved.onboarded.at, '2026-07-20T00:00:00.000Z');
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), '# Root instructions must not replace the pointer\n');
    assert.equal(fs.readFileSync(path.join(ws, 'docs/PROJECT_AI.md'), 'utf8'), '# Existing custom instructions\n');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('cancelling edit review leaves the seeded manifest bytes unchanged', async () => {
  const ws = makeWorkspace({ 'AGENT.md': '# Keep me\n' });
  const seed = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  seed.extra = { futureField: ['keep', 1] };
  saveWorkspaceManifest(ws, seed);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeInstructions = fs.readFileSync(path.join(ws, 'AGENT.md'));
  let persistenceCalls = 0;
  try {
    const result = await runProjectOnboarding(ws, {
      edit: true,
      prompt: async (request) => {
        if (request.id === 'confirm') return { kind: 'cancel' };
        return submitFor(request, {
          'profile': 'research',
          'agent-default': 'researcher',
          'agents-enabled': 'researcher',
        });
      },
      print: () => {},
      persistence: {
        saveManifest() {
          persistenceCalls += 1;
          throw new Error('saveManifest must not run after edit cancellation');
        },
        initInstructions() {
          persistenceCalls += 1;
          throw new Error('initInstructions must not run after edit cancellation');
        },
      },
    });

    assert.equal(result.status, 'cancelled');
    assert.equal(persistenceCalls, 0);
    assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
    assert.deepEqual(fs.readFileSync(path.join(ws, 'AGENT.md')), beforeInstructions);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('/init --edit refuses to overwrite a manifest changed during confirmation', async () => {
  const ws = makeWorkspace({});
  const seed = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, seed);
  const concurrent = createWorkspaceManifest({
    name: 'changed-elsewhere',
    profile: 'writing',
    by: 'import',
    at: '2026-07-21T01:00:00.000Z',
  });
  concurrent.extra = { concurrentRevision: 2 };
  let persistenceCalls = 0;
  try {
    await assert.rejects(
      runProjectOnboarding(ws, {
        edit: true,
        prompt: async (request) => {
          if (request.id === 'confirm') {
            saveWorkspaceManifest(ws, concurrent);
          }
          return submitFor(request, {
            'profile': 'research',
            'agent-default': 'researcher',
            'agents-enabled': 'researcher',
          });
        },
        print: () => {},
        persistence: {
          saveManifest() {
            persistenceCalls += 1;
            throw new Error('stale setup must not reach manifest persistence');
          },
          initInstructions() {
            persistenceCalls += 1;
            throw new Error('stale setup must not reach instruction persistence');
          },
        },
      }),
      /Workspace manifest changed during setup\. No project files were written/,
    );

    assert.equal(persistenceCalls, 0, 'a stale review must abort before either writer runs');
    assert.deepEqual(loadWorkspaceManifest(ws), concurrent, 'the concurrent manifest must remain authoritative');
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('/init --edit treats a concurrent manifest mode change as a new version', { skip: process.platform === 'win32' }, async () => {
  const ws = makeWorkspace({});
  const seed = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, seed);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  const beforeBytes = fs.readFileSync(manifestPath);
  fs.chmodSync(manifestPath, 0o644);
  let persistenceCalls = 0;
  try {
    await assert.rejects(
      runProjectOnboarding(ws, {
        edit: true,
        prompt: async (request) => {
          if (request.id === 'confirm') fs.chmodSync(manifestPath, 0o600);
          return submitFor(request, {});
        },
        print: () => {},
        persistence: {
          saveManifest() {
            persistenceCalls += 1;
            throw new Error('stale setup must not overwrite the concurrent mode');
          },
          initInstructions() {
            persistenceCalls += 1;
            throw new Error('instruction persistence must not run');
          },
        },
      }),
      /Workspace manifest changed during setup\. No project files were written/,
    );

    assert.equal(persistenceCalls, 0);
    assert.deepEqual(fs.readFileSync(manifestPath), beforeBytes);
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest commit CAS preserves a replacement written after the initial snapshot', () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'original',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'desired',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const concurrent = createWorkspaceManifest({
    name: 'concurrent',
    profile: 'writing',
    by: 'import',
    at: '2026-07-21T01:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  let hookCalls = 0;
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage !== 'before-manifest-claim' || event.target !== manifestPath) return;
    hookCalls += 1;
    saveWorkspaceManifest(ws, concurrent);
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, false),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Workspace manifest changed immediately before save/);
        return true;
      },
    );
    assert.equal(hookCalls, 1);
    assert.deepEqual(loadWorkspaceManifest(ws), concurrent);
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      false,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('exclusive manifest commit preserves a creator raced onto an initially absent path', () => {
  const ws = makeWorkspace({});
  const desired = createWorkspaceManifest({
    name: 'desired',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const concurrent = createWorkspaceManifest({
    name: 'concurrent-creator',
    profile: 'writing',
    by: 'import',
    at: '2026-07-21T01:00:00.000Z',
  });
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage === 'before-manifest-claim' && event.target === manifestPath) {
      saveWorkspaceManifest(ws, concurrent, { exclusive: true });
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, false),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /EEXIST|file already exists/);
        return true;
      },
    );
    assert.deepEqual(loadWorkspaceManifest(ws), concurrent);
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('an interrupted manifest claim is restored before the next onboarding read', async () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'recover-after-claim',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'never-committed',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage === 'after-manifest-claim' && event.target === manifestPath) {
      throw new Error('simulated process interruption after claim');
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, false),
      /simulated process interruption after claim/,
    );
    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      true,
    );

    _setProjectOnboardingFilesystemHookForTests(undefined);
    assert.equal(
      isWorkspaceOnboarded(ws),
      true,
      'the shared core readiness chokepoint must restore an interrupted CLI claim',
    );
    assert.deepEqual(loadWorkspaceManifest(ws), original);
    const result = await runProjectOnboarding(ws, {
      prompt: async () => { throw new Error('recovered manifest must suppress fresh onboarding'); },
      print: () => {},
    });
    assert.equal(result.status, 'existing');
    assert.deepEqual(loadWorkspaceManifest(ws), original);
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      false,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest recovery accepts a deterministic replacement written before standalone claim cleanup', () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'standalone-post-write-original',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'standalone-post-write-desired',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  const receiptsBefore = listWorkspaceManifestClaimReceipts();
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage === 'after-manifest-replacement' && event.target === manifestPath) {
      throw new Error('simulated death after standalone manifest replacement');
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, false),
      /simulated death after standalone manifest replacement|rollback was incomplete/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), desired);
    const crashReceipts = [...listWorkspaceManifestClaimReceipts()]
      .filter((receipt) => !receiptsBefore.has(receipt));
    assert.equal(crashReceipts.length, 1);
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      true,
    );

    _setProjectOnboardingFilesystemHookForTests(undefined);
    assert.deepEqual(loadWorkspaceManifest(ws), desired);
    assert.ok(crashReceipts.every((receipt) => !fs.existsSync(receipt)));
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      false,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest claim and pair coordinator jointly recover a post-write crash without stranded receipts', () => {
  const instruction = '# Existing project instructions\n';
  const ws = makeWorkspace({ 'AGENT.md': instruction });
  const original = createWorkspaceManifest({
    name: 'paired-post-write-original',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'paired-post-write-desired',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  const claimReceiptsBefore = listWorkspaceManifestClaimReceipts();
  const pairReceiptsBefore = listWorkspaceOnboardingReceipts();
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage === 'after-manifest-replacement' && event.target === manifestPath) {
      throw new Error('simulated death after paired manifest replacement');
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, true),
      /simulated death after paired manifest replacement|rollback was incomplete/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), desired);
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), instruction);
    const claimReceipts = [...listWorkspaceManifestClaimReceipts()]
      .filter((receipt) => !claimReceiptsBefore.has(receipt));
    const pairReceipts = [...listWorkspaceOnboardingReceipts()]
      .filter((receipt) => !pairReceiptsBefore.has(receipt));
    assert.equal(claimReceipts.length, 1, 'the manifest claim must retain one recovery receipt');
    assert.equal(pairReceipts.length, 1, 'the onboarding pair must retain one coordinator receipt');

    _setProjectOnboardingFilesystemHookForTests(undefined);
    assert.deepEqual(loadWorkspaceManifest(ws), desired);
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), instruction);
    assert.ok(claimReceipts.every((receipt) => !fs.existsSync(receipt)));
    assert.ok(pairReceipts.every((receipt) => !fs.existsSync(receipt)));
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      false,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest recovery retires a claim when a prior recovery already linked the same inode', () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'same-inode-recovery',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'not-committed',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage === 'after-manifest-claim' && event.target === manifestPath) {
      throw new Error('simulated recovery-link crash');
    }
  });

  try {
    assert.throws(() => commitProjectOnboarding(ws, desired, false), /simulated recovery-link crash/);
    _setProjectOnboardingFilesystemHookForTests(undefined);
    const claimName = fs.readdirSync(path.dirname(manifestPath)).find((name) => name.endsWith('.claim'));
    assert.ok(claimName);
    const claimPath = path.join(path.dirname(manifestPath), claimName);
    fs.linkSync(claimPath, manifestPath);
    assert.equal(fs.statSync(claimPath).ino, fs.statSync(manifestPath).ino);

    assert.deepEqual(loadWorkspaceManifest(ws), original);
    assert.equal(fs.existsSync(claimPath), false);
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('live manifest receipt survives recovery in the pre-rename window', () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'original-live-claim',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'desired-live-claim',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  let recovered = false;
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (recovered || event.stage !== 'before-manifest-claim' || event.target !== manifestPath) return;
    recovered = true;
    assert.deepEqual(loadWorkspaceManifest(ws), original);
  });

  try {
    commitProjectOnboarding(ws, desired, false);
    assert.equal(recovered, true);
    assert.deepEqual(loadWorkspaceManifest(ws), desired);
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.claim')),
      false,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('ambiguous manifest claim is never auto-restored after a canonical partial disappears', () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'ambiguous-original',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'ambiguous-desired',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage === 'after-manifest-claim' && event.target === manifestPath) {
      throw new Error('simulated ambiguous manifest interruption');
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, false),
      /simulated ambiguous manifest interruption|rollback was incomplete/,
    );
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.writeFileSync(manifestPath, '{"partial":');
    assert.equal(loadWorkspaceManifest(ws), null);
    const claim = fs.readdirSync(path.dirname(manifestPath)).find((name) => name.endsWith('.claim'));
    assert.ok(claim);
    fs.unlinkSync(manifestPath);
    assert.equal(loadWorkspaceManifest(ws), null);
    assert.equal(fs.existsSync(manifestPath), false, 'an ambiguous old manifest must not be resurrected');
    assert.equal(fs.existsSync(path.join(path.dirname(manifestPath), claim)), true);
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest claim refuses a workspace parent swapped to a symlink', { skip: process.platform === 'win32' }, () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'parent-guard-original',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  const desired = createWorkspaceManifest({
    name: 'parent-guard-desired',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const root = fs.realpathSync(ws);
  const manifestPath = path.join(root, '.brainrouter', 'workspace.json');
  const manifestDirectory = path.dirname(manifestPath);
  const displacedDirectory = `${manifestDirectory}.displaced`;
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'br-manifest-parent-external-'));
  let swapped = false;
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (swapped || event.stage !== 'before-manifest-claim' || event.target !== manifestPath) return;
    swapped = true;
    fs.renameSync(manifestDirectory, displacedDirectory);
    fs.symlinkSync(external, manifestDirectory);
  });

  try {
    assert.throws(() => commitProjectOnboarding(ws, desired, false), /directory changed|path cannot be verified/);
    assert.equal(fs.existsSync(path.join(external, 'workspace.json')), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(displacedDirectory, 'workspace.json'), 'utf8')),
      original,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    if (fs.lstatSync(manifestDirectory).isSymbolicLink()) fs.unlinkSync(manifestDirectory);
    fs.renameSync(displacedDirectory, manifestDirectory);
    // Retire the prepared receipt now that the trusted parent is canonical.
    loadWorkspaceManifest(ws);
    fs.rmSync(external, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('shared manifest recovery removes an owned AGENT.md after death before manifest commit', () => {
  const ws = makeWorkspace({});
  const manifest = createWorkspaceManifest({
    name: 'instruction-only-crash',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const receiptsBefore = listWorkspaceOnboardingReceipts();
  _setProjectOnboardingTransactionHookForTests((event) => {
    if (event.stage === 'after-instruction-commit') {
      throw new Error('simulated death after instruction commit');
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, manifest, true),
      /simulated death after instruction commit/,
    );
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), true);
    assert.equal(fs.existsSync(workspaceManifestPath(ws)), false);
    const crashReceipts = [...listWorkspaceOnboardingReceipts()]
      .filter((receipt) => !receiptsBefore.has(receipt));
    assert.equal(crashReceipts.length, 1, 'the interrupted pair must retain one trusted receipt');

    _setProjectOnboardingTransactionHookForTests(undefined);
    assert.equal(loadWorkspaceManifest(ws), null);
    assertProjectFilesAbsent(ws);
    assert.ok(crashReceipts.every((receipt) => !fs.existsSync(receipt)));
  } finally {
    _setProjectOnboardingTransactionHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('shared manifest recovery accepts a fully written onboarding pair after process death', () => {
  const ws = makeWorkspace({});
  const manifest = createWorkspaceManifest({
    name: 'complete-pair-crash',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const receiptsBefore = listWorkspaceOnboardingReceipts();
  _setProjectOnboardingTransactionHookForTests((event) => {
    if (event.stage === 'after-manifest-commit') {
      throw new Error('simulated death after manifest commit');
    }
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, manifest, true),
      /simulated death after manifest commit/,
    );
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), true);
    assert.equal(fs.existsSync(workspaceManifestPath(ws)), true);
    const crashReceipts = [...listWorkspaceOnboardingReceipts()]
      .filter((receipt) => !receiptsBefore.has(receipt));
    assert.equal(crashReceipts.length, 1, 'the committed pair must retain a recovery receipt');

    _setProjectOnboardingTransactionHookForTests(undefined);
    assert.deepEqual(loadWorkspaceManifest(ws), manifest);
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), true);
    assert.ok(crashReceipts.every((receipt) => !fs.existsSync(receipt)));
  } finally {
    _setProjectOnboardingTransactionHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('instruction failure preserves unowned partial output and leaves the untouched manifest inode alone', () => {
  const ws = makeWorkspace({});
  const original = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-20T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, original);
  const manifestPath = workspaceManifestPath(ws);
  const beforeManifest = fs.readFileSync(manifestPath);
  const beforeManifestInode = fs.statSync(manifestPath).ino;
  const replacement = createWorkspaceManifest({
    name: 'demo',
    profile: 'research',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const calls: string[] = [];
  try {
    assert.throws(
      () => commitProjectOnboarding(ws, replacement, true, {
        saveManifest(workspaceRoot, manifest) {
          calls.push('save-manifest');
          return saveWorkspaceManifest(workspaceRoot, manifest);
        },
        initInstructions(workspaceRoot) {
          calls.push('write-agent-md');
          fs.writeFileSync(path.join(workspaceRoot, 'AGENT.md'), '# Partial write\n', 'utf8');
          throw new Error('instruction writer failed');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: instruction writer failed/);
        return true;
      },
    );

    assert.deepEqual(calls, ['write-agent-md'], 'instruction failure must occur before the durable manifest marker');
    assert.deepEqual(fs.readFileSync(manifestPath), beforeManifest);
    assert.equal(fs.statSync(manifestPath).ino, beforeManifestInode, 'an untouched manifest must not be rewritten');
    assert.equal(
      fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'),
      '# Partial write\n',
      'a failing writer has no ownership receipt, so its output is preserved for recovery',
    );
    assert.equal(loadWorkspaceManifest(ws)?.profile, 'engineering');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest failure rolls back owned AGENT.md but preserves unowned manifest output', () => {
  const ws = makeWorkspace({});
  const manifest = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const calls: string[] = [];
  try {
    assert.throws(
      () => commitProjectOnboarding(ws, manifest, true, {
        initInstructions(workspaceRoot) {
          calls.push('write-agent-md');
          const target = path.join(workspaceRoot, 'AGENT.md');
          fs.writeFileSync(target, '# Created before marker\n', 'utf8');
          return { status: 'created', path: target };
        },
        saveManifest(workspaceRoot) {
          calls.push('save-manifest');
          const target = workspaceManifestPath(workspaceRoot);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, '{"partial":true}', 'utf8');
          throw new Error('manifest writer failed');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: manifest writer failed/);
        return true;
      },
    );

    assert.deepEqual(calls, ['write-agent-md', 'save-manifest']);
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), false, 'the completed instruction writer owns its output');
    assert.equal(fs.readFileSync(workspaceManifestPath(ws), 'utf8'), '{"partial":true}');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('instruction failure before touching disk preserves every existing inode', () => {
  const ws = makeWorkspace({});
  const manifest = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  saveWorkspaceManifest(ws, manifest);
  const manifestPath = workspaceManifestPath(ws);
  const manifestInode = fs.statSync(manifestPath).ino;
  let manifestWrites = 0;
  try {
    assert.throws(
      () => commitProjectOnboarding(ws, manifest, true, {
        initInstructions() {
          throw new Error('instruction denied before write');
        },
        saveManifest() {
          manifestWrites += 1;
          throw new Error('manifest must not run');
        },
      }),
      /instruction denied before write/,
    );
    assert.equal(fs.statSync(manifestPath).ino, manifestInode);
    assert.equal(manifestWrites, 0);
    assert.equal(fs.existsSync(path.join(ws, 'AGENT.md')), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('rollback preserves a concurrent AGENT.md replacement after an owned instruction write', () => {
  const ws = makeWorkspace({});
  const manifest = createWorkspaceManifest({
    name: 'demo',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  try {
    assert.throws(
      () => commitProjectOnboarding(ws, manifest, true, {
        initInstructions(workspaceRoot) {
          const target = path.join(workspaceRoot, 'AGENT.md');
          fs.writeFileSync(target, '# Transaction copy\n');
          return { status: 'created', path: target };
        },
        saveManifest(workspaceRoot) {
          const instructionPath = path.join(workspaceRoot, 'AGENT.md');
          fs.rmSync(instructionPath);
          fs.writeFileSync(instructionPath, '# Concurrent replacement\n', { mode: 0o640 });
          throw new Error('manifest denied after concurrent instruction edit');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: manifest denied after concurrent instruction edit/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(path.join(ws, 'AGENT.md'), 'utf8'), '# Concurrent replacement\n');
    assert.equal(fs.statSync(path.join(ws, 'AGENT.md')).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(workspaceManifestPath(ws)), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('manifest rollback restores a replacement raced between verification and removal', () => {
  const ws = makeWorkspace({});
  const desired = createWorkspaceManifest({
    name: 'transaction',
    profile: 'engineering',
    by: 'wizard',
    at: '2026-07-21T00:00:00.000Z',
  });
  const concurrent = createWorkspaceManifest({
    name: 'concurrent-rollback-writer',
    profile: 'writing',
    by: 'import',
    at: '2026-07-21T02:00:00.000Z',
  });
  const manifestPath = path.join(fs.realpathSync(ws), '.brainrouter', 'workspace.json');
  let rollbackHookCalls = 0;
  _setProjectOnboardingFilesystemHookForTests((event) => {
    if (event.stage !== 'before-remove-quarantine' || event.target !== manifestPath) return;
    rollbackHookCalls += 1;
    saveWorkspaceManifest(ws, concurrent);
  });

  try {
    assert.throws(
      () => commitProjectOnboarding(ws, desired, false, {
        initInstructions() {
          throw new Error('instructions must not run');
        },
        saveManifest(workspaceRoot, manifest, options) {
          const saved = saveWorkspaceManifest(workspaceRoot, manifest, options);
          return `${saved}.unexpected`;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback was incomplete: Workspace manifest writer returned an unexpected path/);
        return true;
      },
    );
    assert.equal(rollbackHookCalls, 1);
    assert.deepEqual(loadWorkspaceManifest(ws), concurrent);
    assert.equal(
      fs.readdirSync(path.dirname(manifestPath)).some((name) => name.endsWith('.rollback')),
      false,
    );
  } finally {
    _setProjectOnboardingFilesystemHookForTests(undefined);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
