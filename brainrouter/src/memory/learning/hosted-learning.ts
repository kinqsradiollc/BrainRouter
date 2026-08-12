import { createHash } from "node:crypto";
import {
  buildLearnedContext,
  buildHumanCorrectionItem,
  learningSessionIdentity,
  selectLearnedForTurn,
  type LearnedItem,
  type LearnedTenant,
} from "@kinqs/brainrouter-core/learning";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import type { LearnedLessonMetadata } from "../lessons/lessonOps.js";
import type { HostedLearningCheckpointRequest } from "../../api/routes/agent/brainChatService.js";
import type {
  HostedLearningAdmissionResult,
  HostedLearningAdmissionPolicy,
} from "../store/postgres/queries/hostedLearningQueries.js";
import { redactSensitiveMemoryText } from "../util/redaction.js";

const LEARNED_ITEM_HEX_CHARS = 18;
const MAX_HOSTED_TRAJECTORY_CHARS = 24_000;
const MIN_HOSTED_TRAJECTORY_CHARS = 400;

/**
 * ADR-032 D5, as scoped for hosted chat: turn end is the ONLY checkpoint here.
 *
 * The other two moments D5 names do not exist on this surface. `/api/brain/chat`
 * is a stateless request that receives the history from the client and never
 * compacts it, so there is no compaction event to hook. And nothing tells the
 * server a hosted session ended — a browser simply stops posting — so a
 * session-end checkpoint would mean keeping a copy of the conversation past the
 * turn for an idle sweep to reflect on later. Hosted therefore reflects on every
 * completed turn instead, under the durable per-session and per-tenant-day
 * budgets. One constant so the fact is stated once rather than re-asserted as a
 * bare literal at each end of the queue.
 */
export const HOSTED_LEARNING_CHECKPOINT_REASON = "turn-end";

/** The generic redactor intentionally anchors `.env` assignments at line
 * start. Hosted trajectories prefix the first line with `user:`/`assistant:`,
 * so redact the role payload separately before the whole-text pass. */
export function redactHostedLearningText(value: string): string {
  const roleSafe = value.split("\n").map((line) => {
    const match = /^(user|assistant):\s?(.*)$/i.exec(line);
    return match
      ? `${match[1]}: ${redactSensitiveMemoryText(match[2] ?? "")}`
      : line;
  }).join("\n");
  return redactSensitiveMemoryText(roleSafe);
}

/** Stable within a tenant and statement, so retries reinforce instead of
 * minting duplicate instruction records. Tenant scope remains part of every
 * database lookup even though it also contributes to the digest. */
export function hostedLearnedItemId(
  tenant: LearnedTenant,
  statement: string,
  origin: LearnedItem["origin"],
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    tenant.orgId?.trim() || null,
    tenant.userId.trim(),
    origin,
    statement.trim().toLowerCase().replace(/\s+/g, " "),
  ])).digest("hex").slice(0, LEARNED_ITEM_HEX_CHARS);
  return `lrn_${digest}`;
}

/** Convert the shared, gate-produced item into the bounded central-memory
 * envelope. The caller still chooses the memory engine and tenant. */
export function hostedLearnedMetadata(
  item: LearnedItem,
  memoryStatus: "active" | "archived" = "active",
): LearnedLessonMetadata {
  return {
    schemaVersion: 1,
    itemId: item.id,
    tier: item.tier,
    origin: item.origin,
    form: item.form,
    falsifier: item.falsifier,
    expectation: item.outcome.expectation,
    status: item.status,
    ...(item.statusReason ? { statusReason: item.statusReason } : {}),
    ...(item.statusChangedAt ? { statusChangedAt: item.statusChangedAt } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    provenance: {
      sessionKey: item.provenance.sessionKey,
      capturedAt: item.provenance.capturedAt,
      checkpoint: item.provenance.checkpoint,
      evidence: [...item.provenance.evidence],
      ...(item.provenance.corroboratingActionIds
        ? { corroboratingActionIds: [...item.provenance.corroboratingActionIds] }
        : {}),
      sawUntrustedContent: item.provenance.sawUntrustedContent,
      gateReasoning: item.provenance.gateReasoning,
    },
    outcome: { ...item.outcome },
    ...(item.skillId ? { skillId: item.skillId } : {}),
    ...(item.allowedTools ? { allowedTools: [...item.allowedTools] } : {}),
    memoryLifecycle: {
      status: memoryStatus,
      updatedAt: item.updatedAt,
      attempts: 1,
    },
  };
}

export interface HostedHumanCorrectionInput {
  tenant: LearnedTenant & { orgId: string };
  sessionKey: string;
  itemId?: string;
  statement: string;
  falsifier: string;
  expectation: string;
  now?: Date;
}

/** Trusted hosted boundary: validate the structured correction with the same
 * D1/D2 gate as device learning, but do not instantiate the filesystem store. */
export function buildHostedHumanCorrection(input: HostedHumanCorrectionInput) {
  return buildHumanCorrectionItem({
    ...input,
    itemId: input.itemId?.trim()
      || hostedLearnedItemId(input.tenant, input.statement, "human-correction"),
  });
}

/** Server-owned provenance for a trusted device correction. The device supplies
 * only its stable item id; it cannot forge another session or tenant label. */
export function hostedCorrectionSessionKey(
  tenant: LearnedTenant & { orgId: string },
  itemId: string,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    tenant.userId.trim(),
    tenant.orgId.trim(),
    itemId.trim(),
    "device-correction",
  ])).digest("hex").slice(0, 32);
  return `hosted-correction:${digest}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

const ITEM_ID = /^lrn_[a-f0-9]{18}$/;

/** Strict central-record decoder shared by hosted prompting and reflection. A
 * malformed envelope is invisible rather than silently gaining authority. */
export function hostedLearnedItemFromRecord(record: CognitiveRecord): LearnedItem | null {
  const learned = object(record.metadata?.learned);
  const provenance = object(learned.provenance);
  const outcome = object(learned.outcome);
  const itemId = safeText(learned.itemId, 64);
  const tier = learned.tier === "instruction" || learned.tier === "evidence" ? learned.tier : null;
  const origin = learned.origin === "human-correction" || learned.origin === "model-inferred"
    ? learned.origin
    : null;
  // `procedure` stays readable here because a Desktop/CLI procedure projects its
  // pointer to central memory for governance; hosted just never runs one.
  const form = learned.form === "lesson" || learned.form === "procedure"
    ? learned.form
    : null;
  const status = learned.status === "active" || learned.status === "demoted"
    || learned.status === "retired" || learned.status === "reverted"
    ? learned.status
    : null;
  const statement = safeText(record.content, 400);
  const falsifier = safeText(learned.falsifier, 400);
  const expectation = safeText(learned.expectation, 400);
  const capturedAt = safeText(provenance.capturedAt, 80);
  const createdAt = safeText(learned.createdAt, 80) || record.createdTime;
  const updatedAt = safeText(learned.updatedAt, 80) || record.updatedTime;
  if (learned.schemaVersion !== 1 || !ITEM_ID.test(itemId) || !tier || !origin || !form || !status
    || !statement || !falsifier || !expectation || !capturedAt
    || !record.userId || !record.orgId) return null;
  // D1 is a provenance invariant, not merely a display convention.
  if (tier === "instruction" && origin !== "human-correction") return null;
  const checkpoint = provenance.checkpoint === "compaction" || provenance.checkpoint === "session-end"
    ? provenance.checkpoint
    : "turn-end";
  const evidence = Array.isArray(provenance.evidence)
    ? provenance.evidence.slice(0, 6).map((line) => safeText(line, 240)).filter(Boolean)
    : [];
  return {
    id: itemId,
    tenant: { userId: record.userId, orgId: record.orgId },
    tier,
    origin,
    form,
    statement,
    falsifier,
    outcome: {
      expectation,
      retrievals: nonNegative(outcome.retrievals),
      confirmations: nonNegative(outcome.confirmations),
      contradictions: nonNegative(outcome.contradictions),
      ...(safeText(outcome.lastRetrievedAt, 80) ? { lastRetrievedAt: safeText(outcome.lastRetrievedAt, 80) } : {}),
      ...(safeText(outcome.lastConfirmedAt, 80) ? { lastConfirmedAt: safeText(outcome.lastConfirmedAt, 80) } : {}),
      ...(safeText(outcome.lastContradictedAt, 80) ? { lastContradictedAt: safeText(outcome.lastContradictedAt, 80) } : {}),
    },
    provenance: {
      sessionKey: safeText(provenance.sessionKey, 200),
      capturedAt,
      checkpoint,
      evidence,
      corroboratedByTrustedAction: origin === "human-correction"
        || (Array.isArray(provenance.corroboratingActionIds) && provenance.corroboratingActionIds.length > 0),
      corroboratingActionIds: Array.isArray(provenance.corroboratingActionIds)
        ? provenance.corroboratingActionIds.slice(0, 8).map((id) => safeText(id, 160)).filter(Boolean)
        : [],
      sawUntrustedContent: provenance.sawUntrustedContent === true,
      gateReasoning: safeText(provenance.gateReasoning, 400),
    },
    status,
    ...(safeText(learned.statusReason, 400) ? { statusReason: safeText(learned.statusReason, 400) } : {}),
    ...(safeText(learned.statusChangedAt, 80) ? { statusChangedAt: safeText(learned.statusChangedAt, 80) } : {}),
    createdAt,
    updatedAt,
    ...(safeText(learned.skillId, 160) ? { skillId: safeText(learned.skillId, 160) } : {}),
    allowedTools: Array.isArray(learned.allowedTools)
      ? learned.allowedTools.slice(0, 32).map((tool) => safeText(tool, 120)).filter(Boolean)
      : [],
    memoryRecordId: record.id,
    memoryLifecycle: {
      status: record.status === "active" && !record.archived ? "active" : "archived",
      updatedAt: record.updatedTime,
      attempts: 1,
    },
  };
}

/** Hosted dashboard chat has no learned-skill/tool activation port. Keep a
 * device-learned procedure visible in governance, but never claim it reached a
 * raw model-only chat turn. */
export function selectHostedLearnedForTurn(items: readonly LearnedItem[]): LearnedItem[] {
  return selectLearnedForTurn(items.filter((item) => item.form === "lesson"));
}

export function hostedLearnedPromptContext(items: readonly LearnedItem[]): string | null {
  return buildLearnedContext(selectHostedLearnedForTurn(items));
}

export interface HostedLearningQueueStore {
  enqueueHostedLearningCheckpointJob(
    input: {
      userId: string;
      orgId: string;
      sessionKeyHash: string;
      requestKey: string;
      jobInput: Record<string, unknown>;
    },
    options?: { now?: Date; policy?: Partial<HostedLearningAdmissionPolicy> },
  ): Promise<HostedLearningAdmissionResult>;
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Tenant-bound identity for one runtime-owned hosted session.  This hash is
 * the only session identifier stored in D6's outcome-observation table; model
 * output can report an item outcome but can never choose its session. */
export function hostedLearningSessionIdentity(
  userId: string,
  orgId: string,
  sessionKey: string,
): string {
  const user = userId.trim();
  const org = orgId.trim();
  if (!user || !org || !sessionKey.trim()) {
    throw new Error("hosted learning session identity requires user, organization, and session");
  }
  return learningSessionIdentity({ userId: user, orgId: org }, sessionKey);
}

/** Validate the post-turn seam and atomically route it through the durable,
 * tenant-budgeted Postgres queue. No reflection/model work happens here. */
export async function enqueueHostedLearningCheckpoint(
  store: Partial<HostedLearningQueueStore>,
  request: HostedLearningCheckpointRequest,
  options?: { now?: Date; policy?: Partial<HostedLearningAdmissionPolicy> },
): Promise<HostedLearningAdmissionResult> {
  const userId = request.userId.trim();
  const orgId = request.orgId.trim();
  const sessionKey = request.sessionKey.trim();
  const trajectory = redactHostedLearningText(
    request.trajectory.trim().slice(0, MAX_HOSTED_TRAJECTORY_CHARS),
  );
  if (!userId || !orgId || !sessionKey) throw new Error("hosted learning requires a pinned user, organization, and session");
  if (!trajectory) throw new Error("hosted learning requires a non-empty bounded trajectory");
  if (request.corroboratedByTrustedAction !== false) {
    throw new Error("hosted chat has no trusted action trace and cannot claim corroboration");
  }
  if (trajectory.length < MIN_HOSTED_TRAJECTORY_CHARS) {
    return {
      admitted: false,
      reason: "trajectory-too-short",
      sessionSpent: 0,
      tenantSpent: 0,
    };
  }
  if (typeof store.enqueueHostedLearningCheckpointJob !== "function") {
    throw new Error("hosted learning durable admission is unavailable");
  }
  const model = request.model.trim().slice(0, 160);
  const retrievedItemIds = [...new Set(
    request.retrievedItemIds.filter((id) => ITEM_ID.test(id)),
  )].slice(0, 16);
  const retrievedItemIdentity = [...retrievedItemIds].sort();
  const sessionIdentity = hostedLearningSessionIdentity(userId, orgId, sessionKey);
  const jobInput: Record<string, unknown> = {
    userId,
    orgId,
    sessionKey,
    reason: request.reason,
    trajectory,
    sawUntrustedContent: request.sawUntrustedContent === true,
    corroboratedByTrustedAction: false,
    model,
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    retrievedItemIds,
  };
  return store.enqueueHostedLearningCheckpointJob({
    userId,
    orgId,
    sessionKeyHash: sessionIdentity,
    requestKey: digest([
      userId,
      orgId,
      sessionKey,
      request.reason,
      trajectory,
      model,
      request.reasoningEffort ?? null,
      request.sawUntrustedContent === true,
      retrievedItemIdentity,
    ]),
    jobInput,
  }, options);
}
