/**
 * ADR-032 Q4 — hosted inspection and human revert for learned behaviour.
 *
 * This surface reads the central memory record only. It never reaches into a
 * CLI/Desktop filesystem and never presents that device-local ledger as hosted
 * state. Connected clients reconcile an explicit central revert at a bounded
 * learning checkpoint.
 */
import { Router } from "express";
import { z } from "zod";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import { createHash } from "node:crypto";
import { memoryEngine } from "../../memory/engine.js";
import { buildHostedHumanCorrection, hostedLearnedMetadata } from "../../memory/learning/hosted-learning.js";
import { redactSensitiveMemoryText } from "../../memory/util/redaction.js";
import { sendError } from "../../contracts/http.js";
import { requireActiveAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";

const PAGE_LIMIT = 200;
const ITEM_ID = /^lrn_[a-f0-9]{18}$/;
const STATUSES = new Set(["active", "demoted", "retired", "reverted"]);
const TIERS = new Set(["evidence", "instruction"]);
const ORIGINS = new Set(["model-inferred", "human-correction"]);
const FORMS = new Set(["lesson", "procedure", "delegation"]);

interface HostedLearnedStore {
  listHostedLearnedRecords(userId: string, orgId: string, limit?: number): Promise<CognitiveRecord[]>;
  revertHostedLearnedRecord(
    userId: string,
    orgId: string,
    itemId: string,
    reason: string,
    now?: Date,
  ): Promise<CognitiveRecord | null>;
  getHostedLearnedRecordByItemId(
    userId: string,
    orgId: string,
    itemId: string,
  ): Promise<CognitiveRecord | null>;
}

export interface HostedLearnedBehavior {
  id: string;
  recordId: string;
  statement: string;
  tier: "evidence" | "instruction";
  origin: "model-inferred" | "human-correction";
  form: "lesson" | "procedure" | "delegation";
  status: "active" | "demoted" | "retired" | "reverted";
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max: number): string | undefined {
  const result = text(value, max);
  return result || undefined;
}

function textArray(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((entry) => text(entry, maxChars)).filter(Boolean)
    : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function enumValue<T extends string>(value: unknown, allowed: Set<string>): T | undefined {
  return typeof value === "string" && allowed.has(value) ? value as T : undefined;
}

/** Pure boundary mapper: malformed/non-learning metadata never reaches the UI. */
export function hostedLearnedBehavior(record: CognitiveRecord): HostedLearnedBehavior | null {
  const learned = object(record.metadata?.learned);
  if (learned.schemaVersion !== 1) return null;
  const id = text(learned.itemId, 64);
  const tier = enumValue<HostedLearnedBehavior["tier"]>(learned.tier, TIERS);
  const origin = enumValue<HostedLearnedBehavior["origin"]>(learned.origin, ORIGINS);
  const form = enumValue<HostedLearnedBehavior["form"]>(learned.form, FORMS);
  const status = enumValue<HostedLearnedBehavior["status"]>(learned.status, STATUSES);
  if (!ITEM_ID.test(id) || !tier || !origin || !form || !status) return null;
  // A human correction can be reduced to evidence by retirement, but no
  // model-inferred projection has authority to appear as an instruction.
  if (tier === "instruction" && origin !== "human-correction") return null;

  const provenance = object(learned.provenance);
  const outcome = object(learned.outcome);
  const lifecycle = object(learned.memoryLifecycle);
  const checkpoint = enumValue<HostedLearnedBehavior["provenance"]["checkpoint"]>(
    provenance.checkpoint ?? learned.checkpoint,
    new Set(["turn-end", "compaction", "session-end"]),
  ) ?? "turn-end";
  const evidence = textArray(provenance.evidence ?? learned.evidence, 6, 240);
  const memoryLifecycle = optionalText(lifecycle.status, 40)
    ? {
      status: text(lifecycle.status, 40),
      updatedAt: text(lifecycle.updatedAt, 80),
      attempts: count(lifecycle.attempts),
      ...(optionalText(lifecycle.lastError, 240) ? { lastError: text(lifecycle.lastError, 240) } : {}),
    }
    : undefined;

  return {
    id,
    recordId: record.id,
    statement: text(record.content, 4_000),
    tier,
    origin,
    form,
    status,
    ...(optionalText(learned.statusReason, 400) ? { statusReason: text(learned.statusReason, 400) } : {}),
    ...(optionalText(learned.statusChangedAt, 80) ? { statusChangedAt: text(learned.statusChangedAt, 80) } : {}),
    createdAt: text(learned.createdAt, 80) || record.createdTime,
    updatedAt: text(learned.updatedAt, 80) || record.updatedTime,
    falsifier: text(learned.falsifier, 400),
    expectation: text(learned.expectation, 400),
    ...(optionalText(learned.skillId, 120) ? { skillId: text(learned.skillId, 120) } : {}),
    allowedTools: textArray(learned.allowedTools, 32, 80),
    provenance: {
      sessionKey: text(provenance.sessionKey, 200),
      capturedAt: text(provenance.capturedAt ?? learned.capturedAt, 80),
      checkpoint,
      evidence,
      corroboratingActionIds: textArray(provenance.corroboratingActionIds, 12, 120),
      sawUntrustedContent: provenance.sawUntrustedContent === true,
      gateReasoning: text(provenance.gateReasoning, 600),
    },
    outcome: {
      retrievals: count(outcome.retrievals),
      confirmations: count(outcome.confirmations),
      contradictions: count(outcome.contradictions),
      ...(optionalText(outcome.lastRetrievedAt, 80) ? { lastRetrievedAt: text(outcome.lastRetrievedAt, 80) } : {}),
      ...(optionalText(outcome.lastConfirmedAt, 80) ? { lastConfirmedAt: text(outcome.lastConfirmedAt, 80) } : {}),
      ...(optionalText(outcome.lastContradictedAt, 80) ? { lastContradictedAt: text(outcome.lastContradictedAt, 80) } : {}),
    },
    ...(memoryLifecycle ? { memoryLifecycle } : {}),
    centralMemory: {
      status: record.status,
      archived: record.archived,
      updatedAt: record.updatedTime,
    },
  };
}

function store(): HostedLearnedStore | null {
  const candidate = memoryEngine.store as Partial<HostedLearnedStore>;
  return typeof candidate.listHostedLearnedRecords === "function"
    && typeof candidate.revertHostedLearnedRecord === "function"
    && typeof candidate.getHostedLearnedRecordByItemId === "function"
    ? candidate as HostedLearnedStore
    : null;
}

const CorrectionBody = z.object({
  sessionKey: z.string().trim().min(1).max(160)
    .regex(/^[A-Za-z0-9._:-]+$/, "sessionKey contains unsupported characters"),
  statement: z.string().trim().min(1).max(400),
  falsifier: z.string().trim().min(1).max(400),
  expectation: z.string().trim().min(1).max(400),
}).strict();

function correctionSessionKey(userId: string, orgId: string, clientSessionKey: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([userId, orgId, clientSessionKey]))
    .digest("hex")
    .slice(0, 32);
  return `hosted-correction:${digest}`;
}

export const learnedBehaviorsRouter = Router();
learnedBehaviorsRouter.use(requireActiveAnyAuth);

/** Explicit authenticated correction ingress. Ordinary chat prose never calls
 * this route and therefore can never mint instruction-tier learned state. */
learnedBehaviorsRouter.post("/correct", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const hosted = store();
  if (!hosted) {
    sendError(res, 503, "Hosted learned behaviour storage is unavailable");
    return;
  }
  try {
    const body = CorrectionBody.parse(req.body ?? {});
    const statement = redactSensitiveMemoryText(body.statement).slice(0, 400);
    const falsifier = redactSensitiveMemoryText(body.falsifier).slice(0, 400);
    const expectation = redactSensitiveMemoryText(body.expectation).slice(0, 400);
    const sessionKey = correctionSessionKey(req.userId!, req.orgId!, body.sessionKey);
    const reviewed = buildHostedHumanCorrection({
      tenant: { userId: req.userId!, orgId: req.orgId! },
      sessionKey,
      statement,
      falsifier,
      expectation,
    });
    if (!reviewed.admitted) {
      sendError(res, 422, `${reviewed.rule}: ${reviewed.reason}`);
      return;
    }
    const recorded = await memoryEngine.recordLesson(req.userId!, reviewed.item.statement, {
      sessionKey,
      orgId: req.orgId!,
      priority: 90,
      kind: "learned-human-correction",
      learned: hostedLearnedMetadata(reviewed.item),
    });
    const central = await hosted.getHostedLearnedRecordByItemId(
      req.userId!, req.orgId!, reviewed.item.id,
    );
    if (!central || central.id !== recorded.recordId
      || central.userId !== req.userId || central.orgId !== req.orgId) {
      sendError(res, 500, "The correction was recorded but could not be verified in the active tenant");
      return;
    }
    const item = hostedLearnedBehavior(central);
    if (!item) {
      sendError(res, 500, "The correction metadata is invalid after recording");
      return;
    }
    res.status(recorded.reinforced ? 200 : 201).json({
      item,
      reinforced: recorded.reinforced,
      source: "authenticated-human-correction",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, 400, error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    console.error("[BrainRouter] learned correction failed:", error instanceof Error ? error.message : error);
    sendError(res, 500, "Could not record the correction");
  }
});

learnedBehaviorsRouter.get("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const hosted = store();
  if (!hosted) {
    sendError(res, 503, "Hosted learned behaviour storage is unavailable");
    return;
  }
  try {
    const records = await hosted.listHostedLearnedRecords(req.userId!, req.orgId!, PAGE_LIMIT + 1);
    // Defense in depth: a faulty adapter cannot turn into a cross-tenant API.
    const scoped = records.filter((record) => record.userId === req.userId && record.orgId === req.orgId);
    const items = scoped.slice(0, PAGE_LIMIT)
      .map(hostedLearnedBehavior)
      .filter((item): item is HostedLearnedBehavior => Boolean(item));
    res.json({
      items,
      truncated: scoped.length > PAGE_LIMIT,
      source: "hosted-memory",
      deviceLedgerIncluded: false,
    });
  } catch (error) {
    console.error("[BrainRouter] learned behaviour listing failed:", error instanceof Error ? error.message : error);
    sendError(res, 500, "Could not load learned behaviour");
  }
});

const RevertBody = z.object({
  reason: z.string().trim().min(3, "A specific revert reason is required").max(400),
}).strict();

learnedBehaviorsRouter.post("/:itemId/revert", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const itemId = String(req.params.itemId ?? "");
  if (!ITEM_ID.test(itemId)) {
    sendError(res, 400, "Invalid learned item id");
    return;
  }
  const hosted = store();
  if (!hosted) {
    sendError(res, 503, "Hosted learned behaviour storage is unavailable");
    return;
  }
  try {
    const body = RevertBody.parse(req.body ?? {});
    const reason = redactSensitiveMemoryText(body.reason).slice(0, 400);
    const updated = await hosted.revertHostedLearnedRecord(
      req.userId!,
      req.orgId!,
      itemId,
      reason,
    );
    // Cross-tenant and unknown ids are deliberately indistinguishable.
    if (!updated || updated.userId !== req.userId || updated.orgId !== req.orgId) {
      sendError(res, 404, "Learned item not found");
      return;
    }
    const item = hostedLearnedBehavior(updated);
    if (!item) {
      sendError(res, 500, "Learned item metadata is invalid after revert");
      return;
    }
    res.json({
      item,
      reconciliation: "central-reverted",
      deviceReconciliation: "next-learning-checkpoint",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(res, 400, error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    console.error("[BrainRouter] learned behaviour revert failed:", error instanceof Error ? error.message : error);
    sendError(res, 500, "Could not revert learned behaviour");
  }
});
