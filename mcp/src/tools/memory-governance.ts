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
    name: "memory_audit",
    description: "List memory audit log entries for a user.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, limit: { type: "number" }, cursor: { type: "object" } },
    },
  },
] as const;

const statusSchema = z.enum(["active", "superseded", "archived", "needs_verification"]);
const verificationSchema = z.enum(["", "verified", "unverified", "stale"]);
const evidenceKindSchema = z.enum(["file", "command", "url", "test", "benchmark", "memory", "other"]);

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
      const params = z.object({ ...baseUser, data: z.any() }).parse(args);
      return toolResult(memoryEngine.importMemories(effectiveUserId(params.userId, options?.defaultUserId), params.data));
    }
    case "memory_governance_delete": {
      const params = z.object({ ...baseUser, recordId: z.string(), reason: z.string().min(1) }).parse(args);
      memoryEngine.governanceDelete(effectiveUserId(params.userId, options?.defaultUserId), params.recordId, params.reason);
      return toolResult({ success: true });
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
    default:
      throw new Error(`Unknown governance tool: ${name}`);
  }
}
