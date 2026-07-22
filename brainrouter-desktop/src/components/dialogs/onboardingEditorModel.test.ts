import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromOnboardingProfile,
  onboardingDraftPreview,
  onboardingSavePayload,
  parseOnboardingCsv,
  parseOnboardingEditor,
  parseOnboardingProposal,
  type OnboardingProfile,
} from './onboardingEditorModel.js';

const digest = (character: string): string => character.repeat(64);

const engineering: OnboardingProfile = {
  id: 'engineering',
  label: 'Engineering',
  description: 'Software projects.',
  agents: { default: 'engineer', enabled: ['engineer'] },
  capabilities: { enabled: ['frontend'], disabled: [] },
  skills: { packs: ['engineering'], enabled: ['testing-skill'], disabled: [] },
  tools: { profiles: ['coding'], deny: [] },
  memory: { tags: ['engineering'], captureHint: 'code' },
};

function response(manifest: unknown = null): Record<string, unknown> {
  return {
    ok: true,
    manifest,
    profiles: [engineering],
    suggestion: { profile: 'engineering', reasons: ['package.json'] },
    review: {
      revision: { root: digest('a'), manifest: digest('b'), instruction: digest('c') },
      instruction: { path: 'AGENT.md', existed: false, bytes: 0, sha256: null },
    },
  };
}

test('hydrates a suggested draft with one engineer and task-scoped frontend capability', () => {
  const parsed = parseOnboardingEditor(response());
  assert.ok(parsed);
  assert.equal(parsed.existing, null);
  assert.equal(parsed.draft.agents.default, 'engineer');
  assert.deepEqual(parsed.draft.agents.enabled, ['engineer']);
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
    agents: { default: 'engineer', enabled: 'engineer' },
  });
  assert.equal(parseOnboardingEditor(malformed), null);
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
    scan: { markers: ['package.json'] },
  });
  assert.ok(parsed);
  assert.equal(parsed.source, 'agent');
  assert.deepEqual(parsed.instruction, { path: 'AGENT.md', contents: '# Project\n' });
  assert.equal(parsed.fallbackReason, 'model-timeout');
  assert.deepEqual(parsed.markers, ['package.json']);

  const unsafe = parseOnboardingProposal({
    proposal: { source: 'model', manifest: draft, instruction: { path: '../AGENT.md', contents: 'unsafe' } },
  });
  assert.ok(unsafe);
  assert.equal(unsafe.instruction, null);
});

test('formats review previews and comma-separated editor fields deterministically', () => {
  const draft = draftFromOnboardingProfile(engineering);
  assert.ok(draft);
  assert.deepEqual(parseOnboardingCsv(' browser, terminal, browser, , coding '), ['browser', 'terminal', 'coding']);
  assert.deepEqual(JSON.parse(onboardingDraftPreview(draft)), draft);
});
