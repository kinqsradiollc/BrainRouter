import test from 'node:test';
import assert from 'node:assert/strict';
import type { RequirementRecord } from '@kinqs/brainrouter-types';
import { buildDelegationPacket, requirementReadyForHandoff } from '../requirement/delegationPacket.js';

function req(over: Partial<RequirementRecord> = {}): RequirementRecord {
  return {
    id: 'req_abc12345',
    title: 'Add a /health endpoint',
    description: 'Expose service liveness.',
    status: 'ready',
    priority: 'medium',
    acceptanceCriteria: ['GET /health returns 200 with {"status":"ok"}', 'covered by a test'],
    clarifyingQuestions: [{ question: 'Auth required?', answer: 'No, public.' }],
    workspaceRoot: '/ws',
    taskIds: [],
    artifactIds: [],
    linkedMemoryIds: ['rec_1', 'rec_2'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('buildDelegationPacket renders a self-contained executor prompt from the requirement', () => {
  const p = buildDelegationPacket(req());
  assert.equal(p.requirementId, 'req_abc12345');
  assert.equal(p.title, 'Add a /health endpoint');
  assert.deepEqual(p.acceptanceCriteria, ['GET /health returns 200 with {"status":"ok"}', 'covered by a test']);
  assert.deepEqual(p.seedRecordIds, ['rec_1', 'rec_2'], 'seeds from linkedMemoryIds');

  const prompt = p.executorPrompt;
  assert.match(prompt, /# Add a \/health endpoint/);
  assert.match(prompt, /Expose service liveness\./);
  // criteria as a numbered checklist
  assert.match(prompt, /1\. GET \/health returns 200/);
  assert.match(prompt, /2\. covered by a test/);
  // settled decisions carried over
  assert.match(prompt, /Q: Auth required\? → A: No, public\./);
  // self-contained directive + traceability id + PR delivery
  assert.match(prompt, /do NOT ask for clarification/i);
  assert.match(prompt, /deliver your work as a reviewable PR/i);
  assert.match(prompt, /req_abc12345/);
});

test('buildDelegationPacket is deterministic + handles missing optionals', () => {
  assert.equal(buildDelegationPacket(req()).executorPrompt, buildDelegationPacket(req()).executorPrompt);
  const bare = buildDelegationPacket(req({ description: undefined, acceptanceCriteria: [], clarifyingQuestions: [], linkedMemoryIds: [] }));
  assert.match(bare.executorPrompt, /none specified/i, 'notes when criteria are absent');
  assert.doesNotMatch(bare.executorPrompt, /Decisions already settled/, 'omits the decisions block when none');
  assert.deepEqual(bare.seedRecordIds, []);
});

test('buildDelegationPacket appends extraContext without breaking the self-contained contract', () => {
  const p = buildDelegationPacket(req(), { extraContext: 'Track item: PROJ-42' });
  assert.match(p.executorPrompt, /## Additional context\nTrack item: PROJ-42/);
});

test('requirementReadyForHandoff: ready needs a title, a criterion, and no open questions', () => {
  assert.deepEqual(requirementReadyForHandoff(req()), { ready: true, missing: [] });

  const noTitle = requirementReadyForHandoff(req({ title: '   ' }));
  assert.equal(noTitle.ready, false);
  assert.ok(noTitle.missing.some((m) => /title/.test(m)));

  const noCriteria = requirementReadyForHandoff(req({ acceptanceCriteria: [] }));
  assert.equal(noCriteria.ready, false);
  assert.ok(noCriteria.missing.some((m) => /acceptance criterion/.test(m)));

  const openQ = requirementReadyForHandoff(req({ clarifyingQuestions: [{ question: 'Which DB?' }] }));
  assert.equal(openQ.ready, false);
  assert.ok(openQ.missing.some((m) => /unanswered/.test(m)));
});
