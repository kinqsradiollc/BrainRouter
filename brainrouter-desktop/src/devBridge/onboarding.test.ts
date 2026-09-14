import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOnboardingProposal } from '../components/dialogs/onboardingEditorModel.js';
import {
  createDevOnboardingState,
  getDevWorkspaceManifest,
  previewDevWorkspaceInstruction,
  previewDevWorkspaceOnboarding,
  proposeDevWorkspaceOnboarding,
  saveDevWorkspaceManifest,
} from './onboarding.js';
import { createQueries } from './queries.js';
import { createDevState } from './state.js';

const root = '/Users/dev/example';

function proposal(info: Record<string, unknown>): Record<string, unknown> {
  const profiles = info.profiles as Array<Record<string, unknown>>;
  const engineering = profiles.find((profile) => profile.id === 'engineering');
  assert.ok(engineering);
  return {
    expected: (info.review as { revision: Record<string, string> }).revision,
    source: 'wizard',
    catalogFingerprint: ((info.preview as { catalogFingerprint: string }).catalogFingerprint),
    profile: engineering.id,
    persona: engineering.persona,
    orchestration: engineering.orchestration,
    capabilities: engineering.capabilities,
    skills: engineering.skills,
    tools: engineering.tools,
    memory: engineering.memory,
    instructions: 'AGENT.md',
  };
}

test('starts un-onboarded with separate persona and orchestration profile fields', () => {
  const info = getDevWorkspaceManifest(createDevOnboardingState(), root);
  assert.equal(info.onboarded, false);
  assert.equal(info.manifest, null);
  const profiles = info.profiles as Array<Record<string, unknown>>;
  const engineering = profiles.find((profile) => profile.id === 'engineering');
  assert.ok(engineering);
  assert.deepEqual((engineering.persona as { enabled: string[] }).enabled, ['engineer']);
  assert.equal((engineering.orchestration as { mode: string }).mode, 'adaptive');
  assert.deepEqual((engineering.capabilities as { enabled: string[] }).enabled, ['frontend', 'backend']);
  assert.ok(!JSON.stringify(engineering).includes('frontend-builder'));
});

test('proposes a complete model-backed engineering draft without mutating state', () => {
  const state = createDevOnboardingState();
  const before = getDevWorkspaceManifest(state, root);
  const result = proposeDevWorkspaceOnboarding(root, {
    description: '  A responsive TypeScript dashboard.  ',
  });
  const parsed = result as {
    proposal: {
      source: string;
      manifest: Record<string, unknown>;
      instruction?: Record<string, unknown>;
    };
    modelAttempted: boolean;
    scan: { markers: string[]; stats: Record<string, number>; stoppedBy: string[] };
  };
  assert.equal(parsed.proposal.source, 'model');
  assert.equal(parsed.modelAttempted, true);
  assert.equal(parsed.proposal.manifest.version, 2);
  assert.equal(parsed.proposal.manifest.profile, 'engineering');
  assert.deepEqual((parsed.proposal.manifest.persona as { enabled: string[] }).enabled, ['engineer']);
  assert.equal((parsed.proposal.manifest.orchestration as { mode: string }).mode, 'adaptive');
  assert.deepEqual((parsed.proposal.manifest.capabilities as { enabled: string[] }).enabled, ['frontend', 'backend']);
  assert.equal(parsed.proposal.instruction?.path, 'AGENT.md');
  assert.deepEqual(parsed.scan.markers, ['package.json', 'tsconfig.json']);
  assert.deepEqual(parsed.scan.stoppedBy, []);
  const rendererProposal = parseOnboardingProposal(result);
  assert.ok(rendererProposal);
  assert.equal(rendererProposal.source, 'agent');
  assert.equal(rendererProposal.draft.profile, 'engineering');
  assert.deepEqual(getDevWorkspaceManifest(state, root), before);
});

test('mirrors deterministic fallback metadata and the description byte ceiling', () => {
  const deterministic = proposeDevWorkspaceOnboarding(root, { mode: 'deterministic' }) as {
    proposal: Record<string, unknown>;
    modelAttempted: boolean;
    fallbackReason?: string;
  };
  assert.equal(deterministic.proposal.source, 'deterministic');
  assert.equal(Object.hasOwn(deterministic.proposal, 'instruction'), false);
  assert.equal(deterministic.modelAttempted, false);
  assert.equal(deterministic.fallbackReason, 'model-unavailable');
  assert.throws(
    () => proposeDevWorkspaceOnboarding(root, { description: 'é'.repeat(2_049) }),
    /exceeds 4096 bytes/,
  );
});

test('registers the assisted proposal under the production query name', () => {
  const queries = createQueries(createDevState());
  const result = queries['workspace-onboarding-propose']?.({ description: 'A web application.' }) as {
    proposal?: { source?: string };
  };
  assert.equal(result.proposal?.source, 'model');
  const preview = queries['workspace-onboarding-preview']?.(
    (result as { proposal?: { manifest?: Record<string, unknown> } }).proposal?.manifest ?? {},
  ) as { ok?: boolean; preview?: { plan?: { id?: string } } };
  assert.equal(preview.ok, true);
  assert.equal(preview.preview?.plan?.id, 'engineering');
});

test('keeps Settings and sidebar support queries available in browser preview', () => {
  const queries = createQueries(createDevState());
  const catalog = queries['tool-catalog']?.({}) as {
    builtin?: Array<{ name: string; protected: boolean }>;
    mcp?: Array<{ server: string; name: string }>;
  };
  assert.ok(catalog.builtin?.some((tool) => tool.name === 'read_file' && tool.protected));
  assert.ok(catalog.mcp?.some((tool) => tool.server === 'workspace'));

  const prMap = queries['git-pr-status-map']?.({}) as {
    prs?: Array<{ state: string; headRefName: string }>;
  };
  assert.ok(prMap.prs?.some((pr) => pr.state === 'OPEN' && pr.headRefName === 'release/0.4.15'));
  assert.deepEqual(queries['account-set-active-org']?.({ orgId: 'org-dev' }), { ok: true, changed: false });
  assert.deepEqual(queries['tooling-check']?.({}), { plan: { kind: 'ready' }, statuses: [] });
});

test('browser preview exposes catalog choices and remains read-only', () => {
  const state = createDevOnboardingState();
  const info = getDevWorkspaceManifest(state, root);
  const result = previewDevWorkspaceOnboarding(root, { profile: 'unknown' });
  assert.equal(result.ok, false);
  const profile = (info.profiles as Array<Record<string, unknown>>)[0]!;
  const reviewed = previewDevWorkspaceOnboarding(root, {
    profile: profile.id,
    persona: profile.persona,
    orchestration: profile.orchestration,
    capabilities: profile.capabilities,
    skills: profile.skills,
    tools: profile.tools,
    memory: profile.memory,
    instructions: 'AGENT.md',
  }) as { ok: boolean; preview?: { catalog?: unknown[] } };
  assert.equal(reviewed.ok, true);
  assert.ok((reviewed.preview?.catalog?.length ?? 0) > 0);
  assert.equal(state.manifests.has(root), false);
});

test('saves reviewed fields in memory and advances the opaque revision', () => {
  const state = createDevOnboardingState();
  const before = getDevWorkspaceManifest(state, root);
  const payload = proposal(before);
  const saved = saveDevWorkspaceManifest(state, root, payload);
  assert.equal(saved.saved, true);

  const after = getDevWorkspaceManifest(state, root);
  assert.equal(after.onboarded, true);
  assert.notDeepEqual(
    (after.review as { revision: unknown }).revision,
    (before.review as { revision: unknown }).revision,
  );
  assert.equal((after.manifest as { name: string }).name, 'example');
  assert.equal((after.manifest as { version: number }).version, 3);
});

test('rejects stale reviews and tracks an approved instruction replacement', () => {
  const state = createDevOnboardingState();
  const before = getDevWorkspaceManifest(state, root);
  const payload = proposal(before);
  assert.equal(saveDevWorkspaceManifest(state, root, payload).saved, true);
  const stale = saveDevWorkspaceManifest(state, root, payload);
  assert.deepEqual(stale, {
    saved: false,
    stale: true,
    error: 'Workspace setup changed while it was open.',
  });

  const latest = getDevWorkspaceManifest(state, root);
  const withInstruction = {
    ...proposal(latest),
    source: 'agent',
    instruction: { path: 'AGENT.md', contents: '# Reviewed project instructions\n' },
  };
  assert.equal(saveDevWorkspaceManifest(state, root, withInstruction).saved, true);
  const summary = (getDevWorkspaceManifest(state, root).review as {
    instruction: { existed: boolean; bytes: number };
  }).instruction;
  assert.equal(summary.existed, true);
  assert.ok(summary.bytes > 0);
});

test('rejects empty and oversized instruction replacements', () => {
  const state = createDevOnboardingState();
  const current = getDevWorkspaceManifest(state, root);
  const base = proposal(current);
  assert.equal(saveDevWorkspaceManifest(state, root, {
    ...base,
    instruction: { path: 'AGENT.md', contents: '' },
  }).saved, false);
  assert.equal(saveDevWorkspaceManifest(state, root, {
    ...base,
    instruction: { path: 'AGENT.md', contents: 'x'.repeat(65_537) },
  }).saved, false);
});

test('previews exact instruction changes without mutating browser-development state', () => {
  const state = createDevOnboardingState();
  state.instructions.set(root, '# Existing\n');
  const current = getDevWorkspaceManifest(state, root);
  const result = previewDevWorkspaceInstruction(state, root, {
    expected: (current.review as { revision: unknown }).revision,
    instruction: { path: 'AGENT.md', contents: '# Proposed\n' },
  });
  assert.deepEqual(result, {
    ok: true,
    path: 'AGENT.md',
    existed: true,
    original: '# Existing\n',
    proposed: '# Proposed\n',
    originalBytes: 11,
    proposedBytes: 11,
  });
  assert.equal(state.instructions.get(root), '# Existing\n');
  assert.equal(state.manifests.has(root), false);
});

test('browser-development instruction preview rejects stale and malformed requests', () => {
  const state = createDevOnboardingState();
  const current = getDevWorkspaceManifest(state, root);
  const expected = (current.review as { revision: unknown }).revision;
  state.instructionRevisions.set(root, 1);
  assert.deepEqual(previewDevWorkspaceInstruction(state, root, {
    expected,
    instruction: { path: 'AGENT.md', contents: '# Proposed\n' },
  }), {
    ok: false,
    stale: true,
    error: 'Workspace setup changed while the instruction was being reviewed.',
  });
  assert.equal(previewDevWorkspaceInstruction(state, root, {
    expected: (getDevWorkspaceManifest(state, root).review as { revision: unknown }).revision,
    instruction: { path: '../AGENT.md', contents: '# Proposed\n' },
  }).ok, false);
  assert.equal(previewDevWorkspaceInstruction(state, root, {
    expected: (getDevWorkspaceManifest(state, root).review as { revision: unknown }).revision,
    instruction: { path: 'AGENT.md', contents: '# Proposed\n', extra: true },
  }).ok, false);
  assert.equal(previewDevWorkspaceInstruction(state, root, {
    expected: {
      ...(getDevWorkspaceManifest(state, root).review as { revision: Record<string, unknown> }).revision,
      extra: true,
    },
    instruction: { path: 'AGENT.md', contents: '# Proposed\n' },
  }).ok, false);
});
