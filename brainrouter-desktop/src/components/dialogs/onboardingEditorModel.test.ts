import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromOnboardingProfile,
  onboardingDescriptionError,
  onboardingDraftPreview,
  onboardingProposalStatus,
  onboardingSavePayload,
  parseOnboardingCsv,
  parseOnboardingEditor,
  parseOnboardingInstructionPreview,
  parseOnboardingProposal,
  type OnboardingProfile,
} from './onboardingEditorModel.js';

const digest = (character: string): string => character.repeat(64);

const engineering: OnboardingProfile = {
  id: 'engineering',
  label: 'Engineering',
  description: 'Software projects.',
  persona: { default: 'engineer', enabled: ['engineer'] },
  orchestration: {
    mode: 'adaptive',
    availableRoles: ['explorer', 'worker', 'reviewer', 'fleet'],
    disabledRoles: ['fleet'],
    maxParallel: 4,
  },
  capabilities: { enabled: ['frontend'], disabled: [] },
  skills: { packs: ['engineering'], enabled: ['testing-skill'], disabled: [] },
  tools: { profiles: ['coding'], enabled: [], deny: [] },
  memory: { tags: ['engineering'], captureHint: 'code' },
};

function response(manifest: unknown = null): Record<string, unknown> {
  return {
    ok: true,
    manifest,
    profiles: [engineering],
    suggestion: { profile: 'engineering', reasons: ['package.json'] },
    preview: previewResponse(),
    review: {
      revision: { root: digest('a'), manifest: digest('b'), instruction: digest('c') },
      instruction: { path: 'AGENT.md', existed: false, bytes: 0, sha256: null },
    },
  };
}

function previewResponse(): Record<string, unknown> {
  return {
    profileId: 'engineering',
    plan: {
      id: 'engineering',
      displayName: 'Engineering orchestration',
      mode: 'adaptive',
      selectedStrategyId: 'direct',
      source: { kind: 'bundled', provenance: 'bundled' },
      selectionReason: 'setup-preview-fallback',
      strategies: [{
        id: 'direct',
        description: 'Complete directly.',
        stages: [{
          id: 'complete',
          executorKind: 'primary',
          skillIds: [],
          optional: false,
          maxChildren: 0,
        }],
      }],
    },
    roles: { planAvailable: [], manifestAvailable: [], disabled: [], effective: ['worker'] },
    skills: { effective: ['testing-skill'], unavailablePacks: [] },
    tools: {
      mode: 'explicit-catalog',
      selectedGroups: ['coding'],
      effectiveToolIds: ['read_file'],
      effectiveExtensionIds: [],
      deniedIds: [],
      migrationRequired: false,
    },
    ceilings: { planMaxParallel: 4, manifestMaxParallel: 4, effectiveMaxParallel: 4 },
    catalogFingerprint: digest('d'),
    catalog: [{
      id: 'coding',
      kind: 'tool-group',
      label: 'Files and code',
      description: 'Inspect and edit files.',
      category: 'files-code',
      source: 'core',
      provenance: 'workspace-tool-groups',
      persistable: true,
      selectable: true,
      runtimeAvailabilityPrerequisites: [],
      expandsTo: ['read_file'],
      selected: true,
      recommended: true,
      denied: false,
    }],
  };
}

test('hydrates separate persona and deny-first orchestration fields', () => {
  const parsed = parseOnboardingEditor(response());
  assert.ok(parsed);
  assert.equal(parsed.existing, null);
  assert.equal(parsed.draft.persona.default, 'engineer');
  assert.deepEqual(parsed.draft.persona.enabled, ['engineer']);
  assert.deepEqual(parsed.draft.orchestration, {
    mode: 'adaptive',
    availableRoles: ['explorer', 'worker', 'reviewer'],
    disabledRoles: ['fleet'],
    maxParallel: 4,
  });
  assert.deepEqual(parsed.draft.capabilities.enabled, ['frontend']);
  assert.ok(!JSON.stringify(parsed.draft).includes('frontend-builder'));
});

test('preserves all three opaque review digests for confirmation-only save', () => {
  const parsed = parseOnboardingEditor(response());
  assert.ok(parsed);
  const payload = onboardingSavePayload({
    draft: parsed.draft,
    revision: parsed.revision,
    source: 'agent',
    catalogFingerprint: digest('d'),
    instruction: { path: 'AGENT.md', contents: '# Reviewed\n' },
    includeInstruction: true,
  });
  assert.deepEqual(payload.expected, {
    root: digest('a'), manifest: digest('b'), instruction: digest('c'),
  });
  assert.deepEqual(payload.instruction, { path: 'AGENT.md', contents: '# Reviewed\n' });

  const withoutInstruction = onboardingSavePayload({
    draft: parsed.draft,
    revision: parsed.revision,
    source: 'wizard',
    catalogFingerprint: digest('d'),
    instruction: { path: 'AGENT.md', contents: '# Not selected\n' },
    includeInstruction: false,
  });
  assert.ok(!Object.hasOwn(withoutInstruction, 'instruction'));
});

test('rejects incomplete revisions and malformed nested manifest fields', () => {
  const missingRoot = response();
  (missingRoot.review as { revision: Record<string, unknown> }).revision = {
    manifest: digest('b'), instruction: digest('c'),
  };
  assert.equal(parseOnboardingEditor(missingRoot), null);

  const malformed = response({
    ...draftFromOnboardingProfile(engineering),
    persona: { default: 'engineer', enabled: 'engineer' },
  });
  assert.equal(parseOnboardingEditor(malformed), null);

  const invalidParallelism = response({
    ...draftFromOnboardingProfile(engineering),
    orchestration: { ...engineering.orchestration, maxParallel: 0 },
  });
  assert.equal(parseOnboardingEditor(invalidParallelism), null);
});

test('parses model proposals and accepts only the fixed instruction target', () => {
  const draft = draftFromOnboardingProfile(engineering);
  const parsed = parseOnboardingProposal({
    proposal: {
      source: 'model',
      manifest: draft,
      reasons: ['Matched the project description.'],
      instruction: { path: 'AGENT.md', contents: '# Project\n' },
    },
    fallbackReason: 'model-timeout',
    scan: {
      markers: ['package.json'],
      stats: { filesRead: 12, bytesRead: 4096 },
      stoppedBy: [],
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.source, 'agent');
  assert.deepEqual(parsed.instruction, { path: 'AGENT.md', contents: '# Project\n' });
  assert.equal(parsed.fallbackReason, 'model-timeout');
  assert.deepEqual(parsed.markers, ['package.json']);
  assert.deepEqual(parsed.scanStats, { filesRead: 12, bytesRead: 4096, stoppedBy: [] });
  assert.match(onboardingProposalStatus(parsed), /AI proposal applied/);
  assert.match(onboardingProposalStatus(parsed), /not included until its exact diff is reviewed/);

  const unsafe = parseOnboardingProposal({
    proposal: { source: 'model', manifest: draft, instruction: { path: '../AGENT.md', contents: 'unsafe' } },
  });
  assert.ok(unsafe);
  assert.equal(unsafe.instruction, null);

  const oversized = parseOnboardingProposal({
    proposal: {
      source: 'model',
      manifest: draft,
      instruction: { path: 'AGENT.md', contents: 'x'.repeat(65_537) },
    },
  });
  assert.ok(oversized);
  assert.equal(oversized.instruction, null);
});

test('validates assisted descriptions by UTF-8 bytes and formats deterministic fallback status', () => {
  assert.equal(onboardingDescriptionError('A TypeScript application.'), null);
  assert.match(onboardingDescriptionError('é'.repeat(2_049)) ?? '', /exceeds 4096 bytes/);

  const draft = draftFromOnboardingProfile(engineering);
  const parsed = parseOnboardingProposal({
    proposal: { source: 'deterministic', manifest: draft, reasons: ['package.json'] },
    fallbackReason: 'model-error',
    scan: { markers: ['package.json'], stats: { filesRead: 4 }, stoppedBy: ['deadline'] },
  });
  assert.ok(parsed);
  assert.equal(parsed.source, 'wizard');
  assert.deepEqual(parsed.scanStats, { filesRead: 4, stoppedBy: ['deadline'] });
  assert.match(onboardingProposalStatus(parsed), /deterministic proposal was used/);
});

test('parses exact instruction previews and rejects altered or oversized renderer payloads', () => {
  assert.deepEqual(parseOnboardingInstructionPreview({
    ok: true,
    path: 'AGENT.md',
    existed: true,
    original: '# Current\n',
    proposed: '# Proposed\n',
    originalBytes: 10,
    proposedBytes: 11,
  }), {
    ok: true,
    path: 'AGENT.md',
    existed: true,
    original: '# Current\n',
    proposed: '# Proposed\n',
    originalBytes: 10,
    proposedBytes: 11,
  });
  assert.deepEqual(parseOnboardingInstructionPreview({
    ok: false,
    stale: true,
    error: 'Workspace setup changed while the instruction was being reviewed.',
  }), {
    ok: false,
    stale: true,
    error: 'Workspace setup changed while the instruction was being reviewed.',
  });
  assert.equal(parseOnboardingInstructionPreview({
    ok: true,
    path: 'AGENT.md',
    existed: false,
    original: '',
    proposed: '# Proposed\n',
    originalBytes: 0,
    proposedBytes: 12,
  }), null);
  assert.equal(parseOnboardingInstructionPreview({
    ok: true,
    path: 'AGENT.md',
    existed: false,
    original: '',
    proposed: 'x'.repeat(65_537),
    originalBytes: 0,
    proposedBytes: 65_537,
  }), null);
});

test('formats review previews and comma-separated editor fields deterministically', () => {
  const draft = draftFromOnboardingProfile(engineering);
  assert.ok(draft);
  assert.deepEqual(parseOnboardingCsv(' browser, terminal, browser, , coding '), ['browser', 'terminal', 'coding']);
  assert.deepEqual(JSON.parse(onboardingDraftPreview(draft)), draft);
});
