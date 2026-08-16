import { createHash } from "node:crypto";
import { z } from "zod";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../../../memory/engine.js";
import {
  buildHostedHumanCorrection,
  hostedCorrectionSessionKey,
  hostedLearnedItemFromRecord,
  hostedLearnedMetadata,
} from "../../../memory/learning/hosted-learning.js";
import { redactSensitiveMemoryText } from "../../../memory/util/redaction.js";
import { handleMemoryRecordLearned } from "../../capture/memory_record_lesson.js";
import { hasLearnedMemoryMetadata } from "../../../memory/util/learned-record.js";

const baseUser = { userId: z.string().optional() };

export const memoryGovernanceToolSchemas = [
  {
    name: "memory_get",
    description: "Fetch a specific memory with attached evidence.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, recordId: { type: "string" } },
      required: ["recordId"],
    },
  },
  {
    name: "memory_update",
    description: "Correct memory content or update trust/status metadata.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        recordId: { type: "string" },
        content: { type: "string" },
        status: { type: "string", enum: ["active", "superseded", "archived", "needs_verification"] },
        confidence: { type: "number" },
        verificationStatus: { type: "string", enum: ["", "verified", "unverified", "stale"] },
        note: { type: "string" },
      },
      required: ["recordId"],
    },
  },
  {
    name: "memory_evidence_add",
    description: "Attach evidence to a memory.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        recordId: { type: "string" },
        kind: { type: "string", enum: ["file", "command", "url", "test", "benchmark", "memory", "other"] },
        ref: { type: "string" },
        excerpt: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["recordId", "kind", "ref"],
    },
  },
  {
    name: "memory_evidence_get",
    description: "Retrieve evidence attached to a memory.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, recordId: { type: "string" } },
      required: ["recordId"],
    },
  },
  {
    name: "memory_export",
    description: "Export all memories, evidence, and audit operations for a user.",
    inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  },
  {
    name: "memory_import",
    description: "Import a BrainRouter memory export envelope.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, data: { type: "object" } },
      required: ["data"],
    },
  },
  {
    name: "memory_governance_delete",
    description: "Hard delete a memory and write an audit record.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, recordId: { type: "string" }, reason: { type: "string" } },
      required: ["recordId", "reason"],
    },
  },
  {
    name: "memory_governance_plan",
    description: "Dry-run: preview a cleanup. scope='cognitive' (default) previews which active memories a filter would sweep (type / olderThanDays / uncitedOnly) — counts by type, estimated reclaimable size, sample ids. scope='storage' previews the 0.4.3 depth tables (source chunks / documents / tree nodes / vault exports) with per-class reclaim estimates (only orphaned source chunks count as reclaimable). scope='all' returns both. Mutates nothing.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        scope: { type: "string", enum: ["cognitive", "storage", "all"], description: "What to preview. Default 'cognitive'." },
        type: { type: "string", description: "Restrict to one memory type (cognitive scope)." },
        olderThanDays: { type: "number", description: "Only records created more than N days ago (cognitive scope)." },
        uncitedOnly: { type: "boolean", description: "Only records that have never been cited (cognitive scope)." },
      },
    },
  },
  {
    name: "memory_verify_anchors",
    description: "Reconcile code-anchored memories against the CURRENT source index. Classifies each anchored memory as fresh, re-anchorable (its file changed — a reindex can refresh the anchor), or archivable (its source file is gone → confirmed-dead). Read-only by default; apply=true archives ONLY the confirmed-dead ones (recoverable expiry, not deletion). Returns counts + a sample. Non-code memories are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        apply: { type: "boolean", description: "Archive the confirmed-dead (archivable) memories. Default false (report only)." },
        limit: { type: "number", description: "Max memories to scan. Default 1000." },
      },
    },
  },
  {
    name: "memory_audit",
    description: "List memory audit log entries for a user.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, limit: { type: "number" }, cursor: { type: "object" } },
    },
  },
  {
    name: "memory_diagnostics",
    description: "Return a scrubbed diagnostics bundle with runtime versions, database stats, env key names, and recent error/degradation logs.",
    inputSchema: { type: "object", properties: { userId: { type: "string" } } },
  },
] as const;

// Shared enum schemas — used both in the import envelope and the individual tool handlers.
const statusSchema = z.enum(["active", "superseded", "archived", "needs_verification"]);
const verificationSchema = z.enum(["", "verified", "unverified", "stale"]);
const evidenceKindSchema = z.enum(["file", "command", "url", "test", "benchmark", "memory", "other"]);
const learnedProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  itemId: z.string().regex(/^lrn_[a-f0-9]{18}$/),
  tier: z.enum(["evidence", "instruction"]),
  origin: z.enum(["model-inferred", "human-correction"]),
  form: z.enum(["lesson", "procedure"]),
  status: z.enum(["active", "demoted", "retired"]),
  statusReason: z.string().max(400).optional(),
  statusChangedAt: z.string().max(80).optional(),
  createdAt: z.string().max(80),
  updatedAt: z.string().max(80),
  falsifier: z.string().max(400),
  expectation: z.string().max(400),
  provenance: z.object({
    sessionKey: z.string().max(200),
    capturedAt: z.string().max(80),
    checkpoint: z.enum(["turn-end", "compaction", "session-end"]),
    evidence: z.array(z.string().max(240)).max(6),
    corroboratingActionIds: z.array(z.string().max(120)).max(8).optional(),
    sawUntrustedContent: z.boolean(),
    gateReasoning: z.string().max(400),
  }).strict(),
  outcome: z.object({
    retrievals: z.number().int().nonnegative(),
    confirmations: z.number().int().nonnegative(),
    contradictions: z.number().int().nonnegative(),
    lastRetrievedAt: z.string().max(80).optional(),
    lastConfirmedAt: z.string().max(80).optional(),
    lastContradictedAt: z.string().max(80).optional(),
  }).strict(),
  skillId: z.string().max(120).optional(),
  allowedTools: z.array(z.string().max(80)).max(32).optional(),
  memoryLifecycle: z.object({
    status: z.enum(["record-pending", "active", "archive-pending", "archived"]),
    updatedAt: z.string().max(80),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().max(240).optional(),
  }).strict().optional(),
}).strict().superRefine((projection, context) => {
  // Human corrections start as instructions but D6 can demote them to
  // evidence. Authority is one-way: model inference can never become an
  // instruction, while human provenance remains valid after demotion.
  const validAuthority = projection.tier !== "instruction"
    || projection.origin === "human-correction";
  if (!validAuthority) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "learned tier does not match its origin authority",
      path: ["tier"],
    });
  }
});

const hostCorrectionInputSchema = z.object({
  itemId: z.string().regex(/^lrn_[a-f0-9]{18}$/),
  statement: z.string().trim().min(1).max(400),
  falsifier: z.string().trim().min(1).max(400),
  expectation: z.string().trim().min(1).max(400),
}).strict();

const hostOutcomeInputSchema = z.object({
  recordId: z.string().trim().min(1).max(200),
  itemId: z.string().regex(/^lrn_[a-f0-9]{18}$/),
  sessionIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(["confirmed", "contradicted"]),
  detail: z.string().max(240),
}).strict();

/** Payload carried by the MCP custom request reserved for CLI/Desktop hosts. */
export const hostLearningRequestParamsSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("identity") }).strict(),
  z.object({ operation: z.literal("correct"), input: hostCorrectionInputSchema }).strict(),
  z.object({ operation: z.literal("record"), input: z.record(z.unknown()) }).strict(),
  z.object({ operation: z.literal("revert"), input: z.record(z.unknown()) }).strict(),
  z.object({ operation: z.literal("outcome"), input: hostOutcomeInputSchema }).strict(),
  z.object({ operation: z.literal("sync"), input: z.record(z.unknown()) }).strict(),
  z.object({ operation: z.literal("lifecycle"), input: z.record(z.unknown()) }).strict(),
]);

const evidenceSchema = z.object({
  id: z.string(),
  userId: z.string().optional(),
  recordId: z.string(),
  kind: evidenceKindSchema,
  ref: z.string(),
  excerpt: z.string().optional().default(""),
  observedAt: z.string().optional().default(""),
  metadata: z.record(z.unknown()).optional().default({}),
});


const memoryRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.string(),
  priority: z.number().optional().default(50),
  sceneName: z.string().optional().default(""),
  skillTag: z.string().optional().default(""),
  sessionKey: z.string().optional().default(""),
  sessionId: z.string().optional().default(""),
  halfLifeDays: z.number().nullable().optional().default(null),
  supersededBy: z.string().nullable().optional().default(null),
  invalidAt: z.string().nullable().optional().default(null),
  timestampStr: z.string().optional().default(""),
  timestampStart: z.string().optional().default(""),
  timestampEnd: z.string().optional().default(""),
  createdTime: z.string().optional().default(""),
  updatedTime: z.string().optional().default(""),
  metadata: z.record(z.unknown()).optional().default({}),
  confidence: z.number().min(0).max(1).optional().default(0.65),
  status: z.enum(["active", "superseded", "archived", "needs_verification"]).optional().default("active"),
  sourceKind: z.string().optional().default(""),
  verificationStatus: z.string().optional().default(""),
  repoPaths: z.array(z.string()).optional().default([]),
  filePaths: z.array(z.string()).optional().default([]),
  commands: z.array(z.string()).optional().default([]),
  citationCount: z.number().optional().default(0),
  lastCitedAt: z.string().nullable().optional().default(null),
  neverCitedCount: z.number().optional().default(0),
  archived: z.boolean().optional().default(false),
});

const importOperationSchema = z.object({
  id: z.string(),
  recordId: z.string().nullable().optional().default(null),
  operation: z.string().min(1),
  actor: z.string().optional().default("system"),
  sessionKey: z.string().optional().default(""),
  reason: z.string().optional().default(""),
  createdAt: z.string(),
  metadata: z.record(z.unknown()).optional().default({}),
});

const importEnvelopeSchema = z.object({
  version: z.literal(1),
  memories: z.array(memoryRecordSchema).optional().default([]),
  evidence: z.array(evidenceSchema).optional().default([]),
  /** Audit operations from a prior export — re-imported for historical continuity. */
  operations: z.array(importOperationSchema).optional().default([]),
});

function effectiveUserId(userId: string | undefined, defaultUserId?: string): string {
  return userId ?? defaultUserId ?? "default";
}

function toolResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function hostLearningError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `host learning failed: ${message}` }],
  };
}

interface HostedCorrectionStore {
  getHostedLearnedRecordByItemId(
    userId: string,
    orgId: string,
    itemId: string,
  ): Promise<CognitiveRecord | null>;
}

function hostedCorrectionStore(): HostedCorrectionStore {
  const candidate = memoryEngine.store as Partial<HostedCorrectionStore>;
  if (typeof candidate.getHostedLearnedRecordByItemId !== "function") {
    throw new Error("hosted learned behaviour storage is unavailable");
  }
  return candidate as HostedCorrectionStore;
}

function boundedCorrectionText(value: string): string {
  return redactSensitiveMemoryText(value.slice(0, 400)).slice(0, 400);
}

function correctionPointer(record: CognitiveRecord, reinforced: boolean) {
  const item = hostedLearnedItemFromRecord(record);
  if (!item || item.origin !== "human-correction") {
    throw new Error("the central learned correction is malformed");
  }
  return {
    found: true,
    itemId: item.id,
    recordId: record.id,
    status: item.status,
    centralStatus: record.status,
    reinforced,
  };
}

async function handleHostHumanCorrection(
  input: z.infer<typeof hostCorrectionInputSchema>,
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  try {
    const userId = effectiveUserId(undefined, options?.defaultUserId).trim();
    const orgId = options?.defaultOrgId?.trim();
    if (!userId || !orgId) throw new Error("organization context is required to record a learned correction");
    const tenant = { userId, orgId };
    const statement = boundedCorrectionText(input.statement);
    const falsifier = boundedCorrectionText(input.falsifier);
    const expectation = boundedCorrectionText(input.expectation);
    const sessionKey = hostedCorrectionSessionKey(tenant, input.itemId);
    const reviewed = buildHostedHumanCorrection({
      tenant,
      itemId: input.itemId,
      sessionKey,
      statement,
      falsifier,
      expectation,
    });
    if (!reviewed.admitted) {
      throw new Error(`${reviewed.rule}: ${reviewed.reason}`);
    }

    const store = hostedCorrectionStore();
    const existing = await store.getHostedLearnedRecordByItemId(userId, orgId, input.itemId);
    if (existing) {
      const item = hostedLearnedItemFromRecord(existing);
      const sameCorrection = item?.origin === "human-correction"
        && item.id === input.itemId
        && item.statement === statement
        && item.falsifier === falsifier
        && item.outcome.expectation === expectation;
      if (!sameCorrection) throw new Error("learned item id already belongs to a different correction");
      return toolResult(correctionPointer(existing, true));
    }

    const recorded = await memoryEngine.recordLesson(userId, reviewed.item.statement, {
      sessionKey,
      orgId,
      priority: 90,
      kind: "learned-human-correction",
      learned: hostedLearnedMetadata(reviewed.item),
    });
    const central = await store.getHostedLearnedRecordByItemId(userId, orgId, input.itemId);
    if (!central || central.id !== recorded.recordId
      || central.userId !== userId || central.orgId !== orgId) {
      throw new Error("the correction was recorded but could not be verified in the active tenant");
    }
    return toolResult(correctionPointer(central, recorded.reinforced));
  } catch (error) {
    return hostLearningError(error);
  }
}

interface HostedOutcomeStore extends HostedCorrectionStore {
  noteHostedLearningOutcomes(
    userId: string,
    orgId: string,
    sessionIdentity: string,
    executionId: string,
    outcomes: readonly { id: string; outcome: "confirmed" | "contradicted"; detail: string }[],
    now?: Date,
    expectedRecordId?: string,
  ): Promise<CognitiveRecord[]>;
}

function hostedOutcomeStore(): HostedOutcomeStore {
  const candidate = memoryEngine.store as Partial<HostedOutcomeStore>;
  if (typeof candidate.getHostedLearnedRecordByItemId !== "function"
    || typeof candidate.noteHostedLearningOutcomes !== "function") {
    throw new Error("hosted learned outcome storage is unavailable");
  }
  return candidate as HostedOutcomeStore;
}

function hostOutcomeExecutionId(
  userId: string,
  orgId: string,
  input: z.infer<typeof hostOutcomeInputSchema>,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    userId,
    orgId,
    input.recordId,
    input.itemId,
    input.sessionIdentity,
    input.outcome,
  ])).digest("hex");
  return `local-outcome:${digest}`;
}

async function handleHostLearningOutcome(
  input: z.infer<typeof hostOutcomeInputSchema>,
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  try {
    const userId = effectiveUserId(undefined, options?.defaultUserId).trim();
    const orgId = options?.defaultOrgId?.trim();
    if (!userId || !orgId) throw new Error("organization context is required to synchronize a learned outcome");
    const store = hostedOutcomeStore();
    const central = await store.getHostedLearnedRecordByItemId(userId, orgId, input.itemId);
    if (!central || central.id !== input.recordId
      || central.userId !== userId || central.orgId !== orgId) {
      return toolResult({ found: false, accepted: false, itemId: input.itemId });
    }
    const detail = redactSensitiveMemoryText(input.detail).slice(0, 240);
    const changed = await store.noteHostedLearningOutcomes(
      userId,
      orgId,
      input.sessionIdentity,
      hostOutcomeExecutionId(userId, orgId, input),
      [{ id: input.itemId, outcome: input.outcome, detail }],
      undefined,
      input.recordId,
    );
    return toolResult({
      found: true,
      accepted: true,
      applied: changed.some((record) => record.id === input.recordId),
      recordId: input.recordId,
      itemId: input.itemId,
      outcome: input.outcome,
    });
  } catch (error) {
    return hostLearningError(error);
  }
}

/**
 * Dispatch learned mutations from the protocol-level host channel. Keeping the
 * operation mapping here makes it impossible for tools/call to reach these
 * handlers merely by guessing their former raw tool names.
 */
export async function handleHostLearningRequest(
  args: unknown,
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  const request = hostLearningRequestParamsSchema.parse(args);
  switch (request.operation) {
    case "identity":
      return toolResult({
        userId: effectiveUserId(undefined, options?.defaultUserId),
        orgId: options?.defaultOrgId?.trim() || null,
      });
    case "correct":
      return handleHostHumanCorrection(request.input, options);
    case "record":
      return handleMemoryRecordLearned(request.input, options);
    case "revert":
      return handleMemoryGovernanceTool("memory_learned_revert", request.input, options);
    case "outcome":
      return handleHostLearningOutcome(request.input, options);
    case "sync":
      return handleMemoryGovernanceTool("memory_learned_sync", request.input, options);
    case "lifecycle":
      return handleMemoryGovernanceTool("memory_learned_lifecycle", request.input, options);
  }
}

export function isLearnedMemoryResult(value: unknown): boolean {
  return hasLearnedMemoryMetadata(value);
}

function withoutLearnedRecords<T extends {
  memories?: unknown[];
  evidence?: Array<{ recordId?: unknown }>;
  operations?: Array<{ recordId?: unknown; operation?: unknown; metadata?: unknown }>;
}>(value: T): T {
  const learnedRecordIds = new Set<string>();
  const memories = (value.memories ?? []).filter((memory) => {
    if (!isLearnedMemoryResult(memory)) return true;
    const id = (memory as { id?: unknown }).id;
    if (typeof id === "string") learnedRecordIds.add(id);
    return false;
  });
  const evidence = (value.evidence ?? []).filter((entry) => (
    typeof entry.recordId !== "string" || !learnedRecordIds.has(entry.recordId)
  ));
  const operations = (value.operations ?? []).filter((entry) => {
    if (typeof entry.recordId === "string" && learnedRecordIds.has(entry.recordId)) return false;
    if (typeof entry.operation === "string" && entry.operation.startsWith("learned_item_")) return false;
    const metadata = entry.metadata;
    return !(metadata && typeof metadata === "object" && !Array.isArray(metadata) && "itemId" in metadata);
  });
  return { ...value, memories, evidence, operations };
}

export async function handleMemoryGovernanceTool(
  name: string,
  args: unknown,
  options?: { defaultUserId?: string; defaultOrgId?: string },
) {
  switch (name) {
    case "memory_get": {
      const params = z.object({ ...baseUser, recordId: z.string() }).parse(args);
      const result = await memoryEngine.getMemoryById(
        effectiveUserId(params.userId, options?.defaultUserId),
        params.recordId,
      );
      // Generic governance reads are only owner-scoped in the legacy store.
      // Learned projections additionally require the server-pinned org and
      // item ID, so make them indistinguishable from a missing generic record.
      return toolResult(isLearnedMemoryResult(result) ? null : result);
    }
    case "memory_update": {
      const params = z.object({
        ...baseUser,
        recordId: z.string(),
        content: z.string().optional(),
        status: statusSchema.optional(),
        confidence: z.number().min(0).max(1).optional(),
        verificationStatus: verificationSchema.optional(),
        note: z.string().optional(),
      }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      const existing = await memoryEngine.getMemoryById(userId, params.recordId);
      if (!existing || isLearnedMemoryResult(existing)) return toolResult(null);
      return toolResult(await memoryEngine.updateMemory(userId, params.recordId, params));
    }
    // Host-only lifecycle RPC: intentionally absent from
    // `memoryGovernanceToolSchemas`, so it is not offered to the model as a
    // selectable tool. Desktop invokes it after an explicit human confirmation.
    // Tenancy comes only from the authenticated MCP session, never from args.
    case "memory_learned_revert": {
      const params = z.object({
        itemId: z.string().regex(/^lrn_[a-f0-9]{18}$/),
        reason: z.string().trim().min(3).max(400),
      }).strict().parse(args);
      const orgId = options?.defaultOrgId?.trim();
      if (!orgId) throw new Error("organization context is required to revert learned behaviour");
      const store = memoryEngine.store as Partial<{
        revertHostedLearnedRecord(
          userId: string,
          orgId: string,
          itemId: string,
          reason: string,
        ): Promise<{ id: string; status: string } | null>;
      }>;
      if (typeof store.revertHostedLearnedRecord !== "function") {
        throw new Error("hosted learned behaviour storage is unavailable");
      }
      const userId = effectiveUserId(undefined, options?.defaultUserId);
      const reason = redactSensitiveMemoryText(params.reason).slice(0, 400);
      const updated = await store.revertHostedLearnedRecord(userId, orgId, params.itemId, reason);
      return toolResult(updated
        ? {
          found: true,
          recordId: updated.id,
          itemId: params.itemId,
          status: "reverted",
          centralStatus: updated.status,
        }
        : { found: false, itemId: params.itemId });
    }
    // Host-only counter/lifecycle mirror. Like revert, this is deliberately not
    // advertised to model tool selection. The database refuses to overwrite an
    // explicit human revert even when a stale device submits an active state.
    case "memory_learned_sync": {
      const params = z.object({
        recordId: z.string().min(1).max(200),
        itemId: z.string().regex(/^lrn_[a-f0-9]{18}$/),
        learned: learnedProjectionSchema,
      }).strict().parse(args);
      if (params.itemId !== params.learned.itemId) throw new Error("learned item id does not match projection");
      const orgId = options?.defaultOrgId?.trim();
      if (!orgId) throw new Error("organization context is required to synchronize learned behaviour");
      const store = memoryEngine.store as Partial<{
        syncHostedLearnedRecord(
          userId: string,
          orgId: string,
          recordId: string,
          itemId: string,
          learned: Record<string, unknown>,
        ): Promise<{ record: { id: string; status: string }; applied: boolean; blockedByHumanRevert: boolean } | null>;
      }>;
      if (typeof store.syncHostedLearnedRecord !== "function") {
        throw new Error("hosted learned behaviour storage is unavailable");
      }
      const result = await store.syncHostedLearnedRecord(
        effectiveUserId(undefined, options?.defaultUserId),
        orgId,
        params.recordId,
        params.itemId,
        params.learned,
      );
      return toolResult(result
        ? {
          found: true,
          recordId: result.record.id,
          itemId: params.itemId,
          applied: result.applied,
          blockedByHumanRevert: result.blockedByHumanRevert,
          centralStatus: result.record.status,
        }
        : { found: false, itemId: params.itemId });
    }
    // Host-only learned record lifecycle. Generic memory_get/update lack the
    // organization and learned-item predicates required for this authority.
    case "memory_learned_lifecycle": {
      const params = z.object({
        operation: z.enum(["inspect", "archive", "restore"]),
        recordId: z.string().min(1).max(200),
        itemId: z.string().regex(/^lrn_[a-f0-9]{18}$/),
        reason: z.string().trim().max(400).optional(),
      }).strict().parse(args);
      if (params.operation !== "inspect" && (params.reason?.length ?? 0) < 3) {
        throw new Error("a lifecycle reason of at least 3 characters is required");
      }
      const orgId = options?.defaultOrgId?.trim();
      if (!orgId) throw new Error("organization context is required for learned behaviour lifecycle");
      const store = memoryEngine.store as Partial<{
        getHostedLearnedLifecycle(
          userId: string,
          orgId: string,
          recordId: string,
          itemId: string,
        ): Promise<{
          record: { id: string };
          learnedStatus: string;
          learnedStatusReason?: string;
          memoryStatus: "active" | "archived";
          applied: boolean;
          blockedByHumanRevert: boolean;
        } | null>;
        transitionHostedLearnedLifecycle(
          userId: string,
          orgId: string,
          recordId: string,
          itemId: string,
          operation: "archive" | "restore",
          reason: string,
        ): Promise<{
          record: { id: string };
          learnedStatus: string;
          learnedStatusReason?: string;
          memoryStatus: "active" | "archived";
          applied: boolean;
          blockedByHumanRevert: boolean;
        } | null>;
      }>;
      const userId = effectiveUserId(undefined, options?.defaultUserId);
      const result = params.operation === "inspect"
        ? (typeof store.getHostedLearnedLifecycle === "function"
          ? await store.getHostedLearnedLifecycle(userId, orgId, params.recordId, params.itemId)
          : undefined)
        : (typeof store.transitionHostedLearnedLifecycle === "function"
          ? await store.transitionHostedLearnedLifecycle(
            userId,
            orgId,
            params.recordId,
            params.itemId,
            params.operation,
            redactSensitiveMemoryText(params.reason ?? "").slice(0, 400),
          )
          : undefined);
      if (result === undefined) throw new Error("hosted learned behaviour storage is unavailable");
      return toolResult(result
        ? {
          found: true,
          recordId: result.record.id,
          itemId: params.itemId,
          learnedStatus: result.learnedStatus,
          ...(result.learnedStatusReason ? { learnedStatusReason: result.learnedStatusReason } : {}),
          memoryStatus: result.memoryStatus,
          applied: result.applied,
          blockedByHumanRevert: result.blockedByHumanRevert,
        }
        : { found: false, itemId: params.itemId });
    }
    case "memory_evidence_add": {
      const params = z.object({
        ...baseUser,
        recordId: z.string(),
        kind: evidenceKindSchema,
        ref: z.string(),
        excerpt: z.string().optional().default(""),
        metadata: z.record(z.unknown()).optional().default({}),
      }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      const existing = await memoryEngine.getMemoryById(userId, params.recordId);
      if (isLearnedMemoryResult(existing)) return toolResult(null);
      return toolResult(await memoryEngine.addEvidence(userId, params.recordId, params));
    }
    case "memory_evidence_get": {
      const params = z.object({ ...baseUser, recordId: z.string() }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      const existing = await memoryEngine.getMemoryById(userId, params.recordId);
      if (isLearnedMemoryResult(existing)) return toolResult(null);
      return toolResult(await memoryEngine.getEvidence(userId, params.recordId));
    }
    case "memory_export": {
      const params = z.object(baseUser).parse(args ?? {});
      const exported = await memoryEngine.exportMemories(effectiveUserId(params.userId, options?.defaultUserId));
      return toolResult(withoutLearnedRecords(exported));
    }
    case "memory_import": {
      const params = z.object({ ...baseUser, data: importEnvelopeSchema }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      if (params.data.memories.some(isLearnedMemoryResult)) {
        throw new Error("learned records cannot be imported through generic memory governance");
      }
      for (const evidence of params.data.evidence) {
        if (isLearnedMemoryResult(await memoryEngine.getMemoryById(userId, evidence.recordId))) {
          throw new Error("learned record evidence requires the organization-scoped learning authority");
        }
      }
      return toolResult(await memoryEngine.importMemories(userId, params.data as any));
    }
    case "memory_governance_delete": {
      const params = z.object({ ...baseUser, recordId: z.string(), reason: z.string().min(1) }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      const existing = await memoryEngine.getMemoryById(userId, params.recordId);
      if (isLearnedMemoryResult(existing)) return toolResult(null);
      await memoryEngine.governanceDelete(userId, params.recordId, params.reason);
      return toolResult({ success: true });
    }
    case "memory_governance_plan": {
      const params = z.object({
        ...baseUser,
        scope: z.enum(["cognitive", "storage", "all"]).optional().default("cognitive"),
        type: z.string().optional(),
        olderThanDays: z.number().optional(),
        uncitedOnly: z.boolean().optional(),
      }).parse(args ?? {});
      const uid = effectiveUserId(params.userId, options?.defaultUserId);
      // MEM-21 — scope chooses cognitive (default), storage (depth tables), or both.
      const cognitive =
        params.scope === "storage"
          ? undefined
          : await memoryEngine.governancePlan(uid, {
              type: params.type,
              olderThanDays: params.olderThanDays,
              uncitedOnly: params.uncitedOnly,
            });
      const storage = params.scope === "cognitive" ? undefined : await memoryEngine.governanceStoragePlan(uid);
      // Back-compat: a bare cognitive plan returns its result unchanged.
      return toolResult(params.scope === "cognitive" ? cognitive : { scope: params.scope, cognitive, storage });
    }
    case "memory_verify_anchors": {
      const params = z.object({
        ...baseUser,
        apply: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(5000).optional(),
      }).parse(args ?? {});
      return toolResult(await memoryEngine.verifyMemories(effectiveUserId(params.userId, options?.defaultUserId), {
        apply: params.apply,
        limit: params.limit,
      }));
    }
    case "memory_audit": {
      const params = z.object({
        ...baseUser,
        limit: z.number().int().min(1).max(200).optional().default(50),
        cursor: z.object({ createdAt: z.string(), id: z.string() }).optional(),
      }).parse(args ?? {});
      const operations = await memoryEngine.getOperationLog(effectiveUserId(params.userId, options?.defaultUserId), {
        limit: params.limit,
        cursor: params.cursor,
      });
      return toolResult(operations.filter((operation) => (
        !operation.operation.startsWith("learned_item_")
        && !(operation.metadata && typeof operation.metadata === "object" && "itemId" in operation.metadata)
      )));
    }
    case "memory_diagnostics": {
      const params = z.object(baseUser).parse(args ?? {});
      return toolResult(await memoryEngine.getDiagnostics(effectiveUserId(params.userId, options?.defaultUserId)));
    }
    default:
      throw new Error(`Unknown governance tool: ${name}`);
  }
}
