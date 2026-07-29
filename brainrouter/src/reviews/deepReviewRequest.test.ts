import { describe, expect, it, vi } from 'vitest';
import { parseDeepReviewPolicy } from '../../../packages/core/src/review/domain/deepReviewPolicy.js';

vi.mock('@kinqs/brainrouter-core/review', async () =>
  import('../../../packages/core/src/review/index.js'));
import { buildManualDeepReviewRequest } from './deepReviewRequest.js';

const config = {
  telemetryThresholds: {
    maxRepositoryFiles: 20_000,
    minIndexedFileRatio: 0.8,
    maxEstimatedModelCalls: 40,
    maxEstimatedToolCalls: 100,
    maxEstimatedDurationMs: 30 * 60_000,
    maxEstimatedUsd: 12,
  },
  packetLimits: {
    maxPackets: 30,
    maxPacketBytes: 16_000,
    maxFilesPerPacket: 12,
  },
  budgets: {
    maxModelCalls: 30,
    maxToolCalls: 80,
    maxDurationMs: 20 * 60_000,
    maxUsd: 8,
  },
};

describe('manual deep-review request binding', () => {
  it('derives authority and the acceptance receipt from authenticated context', () => {
    const policy = buildManualDeepReviewRequest({
      organizationId: 'org-1',
      repository: { forge: 'github', slug: 'Acme/App' },
      program: 'security_review',
      requestedBy: 'user-1',
      config,
      now: '2026-07-30T00:00:00.000Z',
    });

    expect(parseDeepReviewPolicy(policy)).toEqual(policy);
    expect(policy).toMatchObject({
      organizationId: 'org-1',
      repository: { forge: 'github', slug: 'acme/app' },
      program: 'security_review',
      activation: {
        mode: 'explicit_manual',
        requestedBy: 'user-1',
        automaticEscalation: false,
      },
      telemetryThresholds: {
        program: 'security_review',
        acceptedBy: 'user-1',
        acceptedAt: '2026-07-30T00:00:00.000Z',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
    });
  });

  it('cannot widen accepted platform ceilings through request configuration', () => {
    expect(() => buildManualDeepReviewRequest({
      organizationId: 'org-1',
      repository: { forge: 'github', slug: 'acme/app' },
      program: 'code_review',
      requestedBy: 'user-1',
      config: {
        ...config,
        telemetryThresholds: {
          ...config.telemetryThresholds,
          maxEstimatedToolCalls: 1_001,
        },
      },
    })).toThrow(/platform limit/);
  });
});
