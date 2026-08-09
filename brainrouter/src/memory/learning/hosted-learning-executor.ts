import { z } from "zod";
import {
  buildReflectionPrompt,
  evaluateRetirement,
  parseReflectionResponse,
  reviewLearningCandidate,
  type LearnedItem,
  type LearnedTransition,
  type LearningCandidate,
} from "@kinqs/brainrouter-core/learning";
import type { CognitiveRecord, LLMRunner } from "@kinqs/brainrouter-types";
import type { LearnedLessonMetadata, RecordLessonOptions } from "../lessons/lessonOps.js";
import { extractJsonValueOrThrow } from "../util/llm-json.js";
import {
  hostedLearnedItemFromRecord,
  hostedLearnedItemId,
  hostedLearnedMetadata,
  hostedLearningSessionIdentity,
  redactHostedLearningText,
} from "./hosted-learning.js";

const ITEM_ID = /^lrn_[a-f0-9]{18}$/;
const MIN_TRAJECTORY_CHARS = 400;

const HostedCheckpointJob = z.object({
  userId: z.string().trim().min(1).max(200),
  orgId: z.string().trim().min(1).max(200),
  sessionKey: z.string().trim().min(1).max(200),
  reason: z.literal("turn-end"),
  trajectory: z.string().trim().min(1).max(24_000),
  sawUntrustedContent: z.boolean(),
  corroboratedByTrustedAction: z.literal(false),
  model: z.string().trim().max(160),
  reasoningEffort: z.string().trim().max(40).optional(),
  retrievedItemIds: z.array(z.string().regex(ITEM_ID)).max(16),
}).strict();

export interface HostedLearningExecutorStore {
  getHostedLearnedRecordByItemId(userId: string, orgId: string, itemId: string): Promise<CognitiveRecord | null>;
  takeHostedLearnedRetirementBatch(
    userId: string,
    orgId: string,
    limit?: number,
    now?: Date,
  ): Promise<CognitiveRecord[]>;
  noteHostedLearningOutcomes(
    userId: string,
    orgId: string,
    sessionIdentity: string,
    jobId: string,
    outcomes: readonly { id: string; outcome: "confirmed" | "contradicted"; detail: string }[],
    now?: Date,
  ): Promise<CognitiveRecord[]>;
  syncHostedLearnedRecord(
    userId: string,
    orgId: string,
    recordId: string,
    itemId: string,
    learned: LearnedLessonMetadata,
    now?: Date,
  ): Promise<{ applied: boolean; blockedByHumanRevert: boolean } | null>;
}

export interface HostedLearningExecutorEngine {
  modelRunner(role: string, orgId: string): Promise<LLMRunner>;
  recordLesson(
    userId: string,
    text: string,
    options?: RecordLessonOptions,
  ): Promise<{ recordId: string; reinforced: boolean }>;
}

function assertExecutorContext(context: {
  store: HostedLearningExecutorStore;
  engine: HostedLearningExecutorEngine;
  jobId: string;
}): void {
  if (!context.jobId.trim()) throw new Error("hosted learning requires a durable job id");
  const storeMethods: Array<keyof HostedLearningExecutorStore> = [
    "getHostedLearnedRecordByItemId",
    "takeHostedLearnedRetirementBatch",
    "noteHostedLearningOutcomes",
    "syncHostedLearnedRecord",
  ];
  for (const method of storeMethods) {
    if (typeof context.store?.[method] !== "function") {
      throw new Error(`hosted learning store capability ${method} is unavailable`);
    }
  }
  const engineMethods: Array<keyof HostedLearningExecutorEngine> = ["modelRunner", "recordLesson"];
  for (const method of engineMethods) {
    if (typeof context.engine?.[method] !== "function") {
      throw new Error(`hosted learning engine capability ${method} is unavailable`);
    }
  }
}

function strictReflectionEnvelope(raw: string): string {
  const parsed = extractJsonValueOrThrow(raw, {
    kind: "object",
    label: "hosted learning reflector",
  });
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.candidates) || !Array.isArray(record.outcomes)) {
    throw new Error("hosted learning reflector returned an invalid envelope");
  }
  return JSON.stringify(record);
}

function newCandidateItem(
  candidate: LearningCandidate,
  tier: LearnedItem["tier"],
  gateReasoning: string,
  input: z.infer<typeof HostedCheckpointJob>,
  now: Date,
): LearnedItem {
  const at = now.toISOString();
  const tenant = { userId: input.userId, orgId: input.orgId };
  return {
    id: hostedLearnedItemId(tenant, candidate.statement, "model-inferred"),
    tenant,
    tier,
    origin: "model-inferred",
    // Hosted chat has no trusted procedure/tool execution port. The executor
    // rejects those forms below rather than persisting prose that pretends to run.
    form: "lesson",
    statement: candidate.statement,
    falsifier: candidate.falsifier,
    outcome: {
      expectation: candidate.expectation,
      retrievals: 0,
      confirmations: 0,
      contradictions: 0,
    },
    provenance: {
      sessionKey: input.sessionKey,
      capturedAt: at,
      checkpoint: input.reason,
      evidence: [...candidate.evidence],
      corroboratedByTrustedAction: candidate.corroboratedByTrustedAction,
      corroboratingActionIds: candidate.corroboratingActionIds,
      sawUntrustedContent: candidate.sawUntrustedContent,
      gateReasoning,
    },
    status: "active",
    statusChangedAt: at,
    createdAt: at,
    updatedAt: at,
    allowedTools: [],
    memoryLifecycle: { status: "active", updatedAt: at, attempts: 1 },
  };
}

function transitioned(item: LearnedItem, transition: LearnedTransition, now: Date): LearnedItem {
  const at = now.toISOString();
  const status = transition.status;
  return {
    ...item,
    tier: transition.tier ?? item.tier,
    status,
    statusReason: transition.reason,
    statusChangedAt: at,
    updatedAt: at,
    memoryLifecycle: {
      status: status === "active" ? "active" : "archived",
      updatedAt: at,
      attempts: (item.memoryLifecycle?.attempts ?? 0) + 1,
    },
  };
}

async function sweepHostedRetirement(
  store: HostedLearningExecutorStore,
  userId: string,
  orgId: string,
  now: Date,
): Promise<number> {
  const records = await store.takeHostedLearnedRetirementBatch(userId, orgId, 201, now);
  let transitions = 0;
  for (const record of records) {
    if (record.userId !== userId || record.orgId !== orgId) continue;
    const item = hostedLearnedItemFromRecord(record);
    if (!item) continue;
    const decision = evaluateRetirement(item, now.getTime());
    if (!decision) continue;
    const next = transitioned(item, decision, now);
    const synced = await store.syncHostedLearnedRecord(
      userId, orgId, record.id, item.id, hostedLearnedMetadata(next, next.status === "active" ? "active" : "archived"), now,
    );
    if (synced?.applied) transitions += 1;
  }
  return transitions;
}

/** Durable hosted D5 executor. All authority comes from server-pinned job
 * fields and central records; the model can propose only evidence-tier lessons. */
export async function runHostedLearningCheckpoint(
  rawInput: unknown,
  context: {
    store: HostedLearningExecutorStore;
    engine: HostedLearningExecutorEngine;
    jobId: string;
    now?: Date;
  },
): Promise<{
  ran: boolean;
  skippedReason?: string;
  admitted: number;
  rejected: number;
  outcomes: number;
  transitions: number;
}> {
  // Fail before provider resolution: a deployment wiring error must not spend
  // three retrying model calls before discovering that it cannot persist the
  // result or apply lifecycle changes.
  assertExecutorContext(context);
  const input = HostedCheckpointJob.parse(rawInput);
  const now = context.now ?? new Date();
  // Reconstruct the exact delivered snapshot before retirement. Retrieval
  // accounting may have just reached the no-payoff threshold; if the sweep
  // demotes that row first, this same completed turn must still be allowed to
  // report the confirmation that restores it (or the contradiction that
  // retires it). The snapshot is server-loaded from exact delivered ids, never
  // expanded by reflector output.
  const inContext: LearnedItem[] = [];
  for (const itemId of input.retrievedItemIds) {
    const record = await context.store.getHostedLearnedRecordByItemId(input.userId, input.orgId, itemId);
    if (!record || record.userId !== input.userId || record.orgId !== input.orgId) continue;
    const item = hostedLearnedItemFromRecord(record);
    if (item?.status === "active") inContext.push(item);
  }
  // Retirement is deterministic and already admitted as bounded database work.
  // It still runs before provider resolution so a provider failure cannot
  // indefinitely postpone other old or demoted rows in the persistent cursor.
  const transitions = await sweepHostedRetirement(context.store, input.userId, input.orgId, now);
  if (input.trajectory.length < MIN_TRAJECTORY_CHARS) {
    return { ran: false, skippedReason: "trajectory too short", admitted: 0, rejected: 0, outcomes: 0, transitions };
  }
  const prompt = buildReflectionPrompt({ trajectory: input.trajectory, inContext });
  const runner = await context.engine.modelRunner("learning-reflection", input.orgId);
  const raw = await runner.run({
    systemPrompt: prompt.system,
    prompt: prompt.user,
    taskId: `hosted-learning:${context.jobId}`,
    timeoutMs: 60_000,
  });
  const canonicalRaw = strictReflectionEnvelope(raw);
  const reflected = parseReflectionResponse({
    raw: canonicalRaw,
    trajectory: input.trajectory,
    sawUntrustedContent: input.sawUntrustedContent,
    corroboratedByTrustedAction: false,
    eligibleActions: [],
    knownItemIds: new Set(inContext.map((item) => item.id)),
  });

  const changedOutcomes = await context.store.noteHostedLearningOutcomes(
    input.userId,
    input.orgId,
    hostedLearningSessionIdentity(input.userId, input.orgId, input.sessionKey),
    context.jobId,
    reflected.outcomes.map((outcome) => ({
      ...outcome,
      detail: redactHostedLearningText(outcome.detail).slice(0, 240),
    })),
    now,
  );
  let admitted = 0;
  let rejected = 0;
  for (const candidate of reflected.candidates) {
    const verdict = reviewLearningCandidate(candidate);
    // D3 is "runs", never "stored as prose". Hosted chat cannot execute a
    // learned procedure/delegation, so keep it out until that port exists.
    if (!verdict.admitted || candidate.form !== "lesson") {
      rejected += 1;
      continue;
    }
    const proposed = newCandidateItem(candidate, verdict.tier, verdict.reasoning, input, now);
    const existingRecord = await context.store.getHostedLearnedRecordByItemId(
      input.userId, input.orgId, proposed.id,
    );
    const existing = existingRecord ? hostedLearnedItemFromRecord(existingRecord) : null;
    // Re-derivation is not outcome evidence. Only an already-active item may
    // refresh its pointer; demoted/retired/reverted (or malformed) state needs
    // an observed lifecycle transition, never a model-authored resurrection.
    if (existingRecord && existing?.status !== "active") {
      rejected += 1;
      continue;
    }
    const item = existing
      ? { ...existing, updatedAt: now.toISOString() }
      : proposed;
    await context.engine.recordLesson(input.userId, item.statement, {
      sessionKey: input.sessionKey,
      orgId: input.orgId,
      priority: 80,
      kind: "hosted-learned-evidence",
      learned: hostedLearnedMetadata(item, item.status === "active" ? "active" : "archived"),
    });
    admitted += 1;
  }
  return {
    ran: true,
    admitted,
    rejected,
    outcomes: changedOutcomes.length,
    transitions,
  };
}
