"use client";

/**
 * ADR-032 Q4 — browser-safe hosted learned-behaviour client and correction boundary.
 *
 * The active organization travels only in the authenticated request header.
 * Explicit human corrections send exactly the four bounded fields accepted by
 * the server; ordinary chat text never crosses this instruction-tier ingress.
 */
import { authFetch } from "./adminApi";

export type LearnedBehaviorStatus = "active" | "demoted" | "retired" | "reverted";

export interface HostedLearnedBehavior {
  id: string;
  recordId: string;
  statement: string;
  tier: "evidence" | "instruction";
  origin: "model-inferred" | "human-correction";
  form: "lesson" | "procedure" | "delegation";
  status: LearnedBehaviorStatus;
  statusReason?: string;
  statusChangedAt?: string;
  createdAt: string;
  updatedAt: string;
  falsifier: string;
  expectation: string;
  skillId?: string;
  allowedTools: string[];
  provenance: {
    sessionKey: string;
    capturedAt: string;
    checkpoint: "turn-end" | "compaction" | "session-end";
    evidence: string[];
    corroboratingActionIds: string[];
    sawUntrustedContent: boolean;
    gateReasoning: string;
  };
  outcome: {
    retrievals: number;
    confirmations: number;
    contradictions: number;
    lastRetrievedAt?: string;
    lastConfirmedAt?: string;
    lastContradictedAt?: string;
  };
  memoryLifecycle?: {
    status: string;
    updatedAt: string;
    attempts: number;
    lastError?: string;
  };
  centralMemory: {
    status: string;
    archived: boolean;
    updatedAt: string;
  };
}

export interface HostedLearnedBehaviorPage {
  items: HostedLearnedBehavior[];
  truncated: boolean;
  source: "hosted-memory";
  deviceLedgerIncluded: false;
}

export interface HostedHumanCorrectionInput {
  sessionKey: string;
  statement: string;
  falsifier: string;
  expectation: string;
}

export type HostedHumanCorrectionErrors = Partial<Record<keyof HostedHumanCorrectionInput, string>>;

export const HOSTED_CORRECTION_LIMITS = {
  sessionKey: 160,
  text: 400,
} as const;

const SESSION_KEY = /^[A-Za-z0-9._:-]+$/;

export function normalizeHostedHumanCorrection(
  input: HostedHumanCorrectionInput,
): HostedHumanCorrectionInput {
  return {
    sessionKey: input.sessionKey.trim(),
    statement: input.statement.trim(),
    falsifier: input.falsifier.trim(),
    expectation: input.expectation.trim(),
  };
}

/** Mirror only stable, user-actionable ingress limits. The server remains the
 * authority for the learning gate and explains any semantic rejection. */
export function hostedHumanCorrectionErrors(
  input: HostedHumanCorrectionInput,
): HostedHumanCorrectionErrors {
  const value = normalizeHostedHumanCorrection(input);
  const errors: HostedHumanCorrectionErrors = {};
  if (!value.sessionKey) errors.sessionKey = "Enter the session key this correction belongs to.";
  else if (value.sessionKey.length > HOSTED_CORRECTION_LIMITS.sessionKey) {
    errors.sessionKey = `Session keys can be at most ${HOSTED_CORRECTION_LIMITS.sessionKey} characters.`;
  } else if (!SESSION_KEY.test(value.sessionKey)) {
    errors.sessionKey = "Use only letters, numbers, dots, underscores, colons, and hyphens.";
  }
  if (value.statement.length < 12) {
    errors.statement = "Describe a concrete correction in at least 12 characters.";
  } else if (value.statement.length > HOSTED_CORRECTION_LIMITS.text) {
    errors.statement = `Corrections can be at most ${HOSTED_CORRECTION_LIMITS.text} characters.`;
  }
  if (value.falsifier.length < 10 || value.falsifier.split(/\s+/).length < 3) {
    errors.falsifier = "Name an observable contrary result in at least three words.";
  } else if (value.falsifier.length > HOSTED_CORRECTION_LIMITS.text) {
    errors.falsifier = `Contrary results can be at most ${HOSTED_CORRECTION_LIMITS.text} characters.`;
  } else if (value.falsifier.toLowerCase() === value.statement.toLowerCase()) {
    errors.falsifier = "The contrary result must not restate the correction.";
  }
  if (!value.expectation) {
    errors.expectation = "Describe the improvement this correction should produce.";
  } else if (value.expectation.length > HOSTED_CORRECTION_LIMITS.text) {
    errors.expectation = `Expected improvements can be at most ${HOSTED_CORRECTION_LIMITS.text} characters.`;
  }
  return errors;
}

export function upsertHostedLearnedBehavior(
  items: readonly HostedLearnedBehavior[],
  next: HostedLearnedBehavior,
): HostedLearnedBehavior[] {
  return [next, ...items.filter((item) => item.id !== next.id)];
}

export const learnedBehaviorsApi = {
  list(orgId: string, signal?: AbortSignal): Promise<HostedLearnedBehaviorPage> {
    return authFetch<HostedLearnedBehaviorPage>("/api/learned-behaviors", { orgId, signal });
  },

  correct(orgId: string, input: HostedHumanCorrectionInput): Promise<{
    item: HostedLearnedBehavior;
    reinforced: boolean;
    source: "authenticated-human-correction";
  }> {
    return authFetch("/api/learned-behaviors/correct", {
      method: "POST",
      orgId,
      body: {
        sessionKey: input.sessionKey,
        statement: input.statement,
        falsifier: input.falsifier,
        expectation: input.expectation,
      },
    });
  },

  revert(orgId: string, itemId: string, reason: string): Promise<{
    item: HostedLearnedBehavior;
    reconciliation: "central-reverted";
    deviceReconciliation: "next-learning-checkpoint";
  }> {
    return authFetch(`/api/learned-behaviors/${encodeURIComponent(itemId)}/revert`, {
      method: "POST",
      orgId,
      body: { reason },
    });
  },
};
