import type { DeepReviewRequestConfig } from './deepReview.js';

/**
 * Conservative limits offered by maintained hosts for a manual deep review.
 *
 * Selecting this preset never activates deep review by itself. A host must show
 * these limits, collect a per-run acceptance, and send mode="deep" explicitly.
 * The backend remains authoritative and rejects values outside platform policy.
 */
export const MANUAL_DEEP_REVIEW_PRESET = Object.freeze({
  telemetryThresholds: Object.freeze({
    maxRepositoryFiles: 20_000,
    minIndexedFileRatio: 0.8,
    maxEstimatedModelCalls: 40,
    maxEstimatedToolCalls: 100,
    maxEstimatedDurationMs: 30 * 60_000,
    maxEstimatedUsd: 12,
  }),
  packetLimits: Object.freeze({
    maxPackets: 30,
    maxPacketBytes: 16_000,
    maxFilesPerPacket: 12,
  }),
  budgets: Object.freeze({
    maxModelCalls: 30,
    maxToolCalls: 80,
    maxDurationMs: 20 * 60_000,
    maxUsd: 8,
  }),
  cancellationPollIntervalMs: 1_000,
}) satisfies DeepReviewRequestConfig;

export interface ManualDeepReviewLimitLine {
  label: string;
  value: string;
}

export function manualDeepReviewRequestConfig(): DeepReviewRequestConfig {
  return {
    telemetryThresholds: { ...MANUAL_DEEP_REVIEW_PRESET.telemetryThresholds },
    packetLimits: { ...MANUAL_DEEP_REVIEW_PRESET.packetLimits },
    budgets: { ...MANUAL_DEEP_REVIEW_PRESET.budgets },
    cancellationPollIntervalMs: MANUAL_DEEP_REVIEW_PRESET.cancellationPollIntervalMs,
  };
}

export function manualDeepReviewLimitLines(): ManualDeepReviewLimitLine[] {
  const thresholds = MANUAL_DEEP_REVIEW_PRESET.telemetryThresholds;
  const packets = MANUAL_DEEP_REVIEW_PRESET.packetLimits;
  const budgets = MANUAL_DEEP_REVIEW_PRESET.budgets;
  return [
    {
      label: 'Preflight',
      value: `${thresholds.maxRepositoryFiles.toLocaleString('en-US')} files · ${Math.round(thresholds.minIndexedFileRatio * 100)}% indexed`,
    },
    {
      label: 'Accepted estimate',
      value: `${thresholds.maxEstimatedModelCalls} model · ${thresholds.maxEstimatedToolCalls} tool · ${thresholds.maxEstimatedDurationMs / 60_000} min · $${thresholds.maxEstimatedUsd}`,
    },
    {
      label: 'Run budget',
      value: `${budgets.maxModelCalls} model · ${budgets.maxToolCalls} tool · ${budgets.maxDurationMs / 60_000} min · $${budgets.maxUsd}`,
    },
    {
      label: 'Context',
      value: `${packets.maxPackets} packets · ${Math.round(packets.maxPacketBytes / 1_000)} KB · ${packets.maxFilesPerPacket} files each`,
    },
  ];
}
