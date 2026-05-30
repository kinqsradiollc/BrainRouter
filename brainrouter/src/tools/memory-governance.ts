import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

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
    description: "Dry-run: preview which active memories a cleanup filter would sweep (type / olderThanDays / uncitedOnly) — counts by type, an estimated reclaimable size, and a sample of record ids. Mutates nothing; run before memory_governance_delete.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        type: { type: "string", description: "Restrict to one memory type." },
        olderThanDays: { type: "number", description: "Only records created more than N days ago." },
        uncitedOnly: { type: "boolean", description: "Only records that have never been cited." },
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

export async function handleMemoryGovernanceTool(name: string, args: unknown, options?: { defaultUserId?: string }) {
  switch (name) {
    case "memory_get": {
      const params = z.object({ ...baseUser, recordId: z.string() }).parse(args);
      return toolResult(memoryEngine.getMemoryById(effectiveUserId(params.userId, options?.defaultUserId), params.recordId));
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
      return toolResult(memoryEngine.updateMemory(effectiveUserId(params.userId, options?.defaultUserId), params.recordId, params));
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
      return toolResult(memoryEngine.addEvidence(effectiveUserId(params.userId, options?.defaultUserId), params.recordId, params));
    }
    case "memory_evidence_get": {
      const params = z.object({ ...baseUser, recordId: z.string() }).parse(args);
      return toolResult(memoryEngine.getEvidence(effectiveUserId(params.userId, options?.defaultUserId), params.recordId));
    }
    case "memory_export": {
      const params = z.object(baseUser).parse(args ?? {});
      return toolResult(memoryEngine.exportMemories(effectiveUserId(params.userId, options?.defaultUserId)));
    }
    case "memory_import": {
      const params = z.object({ ...baseUser, data: importEnvelopeSchema }).parse(args);
      return toolResult(memoryEngine.importMemories(effectiveUserId(params.userId, options?.defaultUserId), params.data as any));
    }
    case "memory_governance_delete": {
      const params = z.object({ ...baseUser, recordId: z.string(), reason: z.string().min(1) }).parse(args);
      memoryEngine.governanceDelete(effectiveUserId(params.userId, options?.defaultUserId), params.recordId, params.reason);
      return toolResult({ success: true });
    }
    case "memory_governance_plan": {
      const params = z.object({
        ...baseUser,
        type: z.string().optional(),
        olderThanDays: z.number().optional(),
        uncitedOnly: z.boolean().optional(),
      }).parse(args ?? {});
      return toolResult(
        memoryEngine.governancePlan(effectiveUserId(params.userId, options?.defaultUserId), {
          type: params.type,
          olderThanDays: params.olderThanDays,
          uncitedOnly: params.uncitedOnly,
        }),
      );
    }
    case "memory_audit": {
      const params = z.object({
        ...baseUser,
        limit: z.number().int().min(1).max(200).optional().default(50),
        cursor: z.object({ createdAt: z.string(), id: z.string() }).optional(),
      }).parse(args ?? {});
      return toolResult(memoryEngine.getOperationLog(effectiveUserId(params.userId, options?.defaultUserId), {
        limit: params.limit,
        cursor: params.cursor,
      }));
    }
    case "memory_diagnostics": {
      const params = z.object(baseUser).parse(args ?? {});
      return toolResult(memoryEngine.getDiagnostics(effectiveUserId(params.userId, options?.defaultUserId)));
    }
    default:
      throw new Error(`Unknown governance tool: ${name}`);
  }
}
