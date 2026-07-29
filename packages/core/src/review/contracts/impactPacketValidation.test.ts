import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssuranceImpactPacketAssembly, AssurancePolicySnapshot } from '@kinqs/brainrouter-types/review';
import { validateAssuranceImpactPacketAssembly } from './impactPacketValidation.js';

const revision = { baseSha: 'base', headSha: 'head' };

const policy: AssurancePolicySnapshot = {
  id: 'policy-1',
  policyHash: 'sha256:policy',
  organizationId: 'org-1',
  program: 'security_review',
  analyzers: [],
  packetLimits: { maxPackets: 2, maxPacketBytes: 1_000, maxFilesPerPacket: 3 },
  budgets: { maxModelCalls: 2, maxToolCalls: 5, maxDurationMs: 60_000 },
  redactionPolicyId: 'redact-1',
  publicationPolicyId: 'publish-1',
  inlineFindingsEnabled: false,
  blockingEnabled: true,
  createdAt: '2026-07-29T00:00:00.000Z',
};

function assembly(): AssuranceImpactPacketAssembly {
  return {
    revisionSha: 'head',
    indexRef: 'index-1',
    packets: [
      {
        id: 'packet-1',
        revisionSha: 'head',
        program: 'security_review',
        changed: [{ path: 'src/route.ts', line: 10, symbol: 'route' }],
        context: [
          {
            relationship: 'caller',
            distance: 1,
            evidence: {
              id: 'evidence-caller',
              kind: 'call_path',
              summary: 'handler calls the changed route',
              revisionSha: 'head',
              location: { path: 'src/handler.ts', line: 20, symbol: 'handler' },
              createdAt: '2026-07-29T00:00:01.000Z',
            },
          },
        ],
        sourceToSinkPaths: [
          {
            id: 'path-1',
            source: { path: 'src/handler.ts', line: 20 },
            sink: { path: 'src/route.ts', line: 10 },
            evidenceRefs: ['evidence-caller', 'evidence-sink'],
          },
        ],
        artifactRefs: ['artifact-1'],
        byteCount: 640,
        truncated: false,
        limitationIds: [],
      },
    ],
    limitations: [],
    assembledAt: '2026-07-29T00:00:02.000Z',
  };
}

test('accepts a bounded exact-head packet assembly', () => {
  assert.deepEqual(validateAssuranceImpactPacketAssembly(assembly(), revision, policy), { ok: true, issues: [] });
});

test('rejects stale evidence and packets that exceed policy bounds', () => {
  const value = assembly();
  value.packets.push({
    ...structuredClone(value.packets[0]),
    id: 'packet-2',
    byteCount: 1_001,
    context: [
      {
        ...structuredClone(value.packets[0].context[0]),
        evidence: {
          ...structuredClone(value.packets[0].context[0].evidence),
          revisionSha: 'old-head',
        },
      },
    ],
  });
  const result = validateAssuranceImpactPacketAssembly(value, revision, policy);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('byte limit')));
  assert.ok(result.issues.some((issue) => issue.includes('stale context evidence')));
});

test('requires explicit limitations for truncation and source-to-sink evidence', () => {
  const value = assembly();
  value.packets[0].truncated = true;
  value.packets[0].sourceToSinkPaths[0].evidenceRefs = ['only-one'];
  const result = validateAssuranceImpactPacketAssembly(value, revision, policy);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('requires a coverage limitation')));
  assert.ok(result.issues.some((issue) => issue.includes('lacks path evidence')));
});

test('rejects invalid graph distance, file bounds, and unknown limitations', () => {
  const value = assembly();
  value.packets[0].context[0].distance = -1;
  value.packets[0].sourceToSinkPaths[0].source.path = 'src/source.ts';
  value.packets[0].sourceToSinkPaths[0].sink.path = 'src/sink.ts';
  value.packets[0].limitationIds = ['missing-limitation'];
  const result = validateAssuranceImpactPacketAssembly(value, revision, policy);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('invalid graph distance')));
  assert.ok(result.issues.some((issue) => issue.includes('file limit')));
  assert.ok(result.issues.some((issue) => issue.includes('unknown limitation')));
});
