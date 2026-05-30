import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

const baseUser = { userId: z.string().optional() };

function effectiveUserId(userId: string | undefined, defaultUserId?: string): string {
  return userId ?? defaultUserId ?? "default";
}

function toolResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const stringList = z.array(z.string()).optional().default([]);

export const memoryEngineeringToolSchemas = [
  {
    name: "memory_debug_trace_save",
    description: "Save an engineering debug trace, including repro, cause, fix, verification, files, and commands.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        sessionKey: { type: "string" },
        activeSkill: { type: "string" },
        symptom: { type: "string" },
        reproSteps: { type: "array", items: { type: "string" } },
        suspectedCause: { type: "string" },
        confirmedCause: { type: "string" },
        fixSummary: { type: "string" },
        verificationResult: { type: "string" },
        failedAttempt: { type: "string" },
        filePaths: { type: "array", items: { type: "string" } },
        commands: { type: "array", items: { type: "string" } },
      },
      required: ["symptom"],
    },
  },
  {
    name: "memory_debug_trace_search",
    description: "Search prior engineering debug traces by error, file, command, or symptom.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "memory_failed_attempts",
    description: "Return previously recorded failed attempts for a problem area.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "memory_file_history",
    description: "Return memories and evidence associated with a file path or symbol.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, filePath: { type: "string" }, limit: { type: "number" } },
      required: ["filePath"],
    },
  },
  {
    name: "memory_task_state",
    description: "Read current task or handover state for a repo/session.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "memory_task_update",
    description: "Write structured task progress, blockers, and next actions.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        sessionKey: { type: "string" },
        activeSkill: { type: "string" },
        status: { type: "string" },
        completed: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
        nextActions: { type: "array", items: { type: "string" } },
        filePaths: { type: "array", items: { type: "string" } },
      },
      required: ["status"],
    },
  },
  {
    name: "memory_handover",
    description: "Generate a compact continuation note from current task memories.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "memory_verify",
    description: "Inspect and/or update a memory's verification. Always returns the record plus its source-chunk provenance (the excerpts it was distilled from); omit verificationStatus to inspect read-only, or pass it (and optional confidence/status/note) to also record a re-check.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        recordId: { type: "string" },
        confidence: { type: "number" },
        status: { type: "string", enum: ["active", "superseded", "archived", "needs_verification"] },
        verificationStatus: { type: "string", enum: ["", "verified", "unverified", "stale"] },
        note: { type: "string" },
      },
      required: ["recordId"],
    },
  },
] as const;

export async function handleMemoryEngineeringTool(name: string, args: unknown, options?: { defaultUserId?: string }) {
  switch (name) {
    case "memory_debug_trace_save": {
      const params = z.object({
        ...baseUser,
        sessionKey: z.string().optional(),
        activeSkill: z.string().optional(),
        symptom: z.string().min(1),
        reproSteps: stringList,
        suspectedCause: z.string().optional(),
        confirmedCause: z.string().optional(),
        fixSummary: z.string().optional(),
        verificationResult: z.string().optional(),
        failedAttempt: z.string().optional(),
        filePaths: stringList,
        commands: stringList,
      }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      const records = [
        memoryEngine.upsertEngineeringMemory({
          userId,
          sessionKey: params.sessionKey,
          activeSkill: params.activeSkill,
          type: "bug_finding",
          content: `Bug finding: ${params.symptom}${params.confirmedCause ? `. Confirmed cause: ${params.confirmedCause}` : ""}`,
          priority: 85,
          sourceKind: "user_instruction",
          filePaths: params.filePaths,
          commands: params.commands,
        }),
        memoryEngine.upsertEngineeringMemory({
          userId,
          sessionKey: params.sessionKey,
          activeSkill: params.activeSkill,
          type: "debug_trace",
          content: [
            `Debug symptom: ${params.symptom}`,
            params.reproSteps.length ? `Repro steps: ${params.reproSteps.join("; ")}` : "",
            params.suspectedCause ? `Suspected cause: ${params.suspectedCause}` : "",
            params.confirmedCause ? `Confirmed cause: ${params.confirmedCause}` : "",
          ].filter(Boolean).join(". "),
          priority: 80,
          sourceKind: "user_instruction",
          filePaths: params.filePaths,
          commands: params.commands,
          metadata: { reproSteps: params.reproSteps },
        }),
      ];
      if (params.failedAttempt) {
        records.push(memoryEngine.upsertEngineeringMemory({
          userId,
          sessionKey: params.sessionKey,
          activeSkill: params.activeSkill,
          type: "failed_attempt",
          content: `Failed attempt: ${params.failedAttempt}`,
          priority: 70,
          filePaths: params.filePaths,
          commands: params.commands,
        }));
      }
      if (params.fixSummary) {
        records.push(memoryEngine.upsertEngineeringMemory({
          userId,
          sessionKey: params.sessionKey,
          activeSkill: params.activeSkill,
          type: "fix_summary",
          content: `Fix summary: ${params.fixSummary}`,
          priority: 80,
          filePaths: params.filePaths,
          commands: params.commands,
        }));
      }
      if (params.verificationResult) {
        records.push(memoryEngine.upsertEngineeringMemory({
          userId,
          sessionKey: params.sessionKey,
          activeSkill: params.activeSkill,
          type: "verification_result",
          content: `Verification result: ${params.verificationResult}`,
          priority: 75,
          sourceKind: "test_result",
          verificationStatus: "verified",
          filePaths: params.filePaths,
          commands: params.commands,
        }));
      }
      return toolResult({ records });
    }
    case "memory_debug_trace_search": {
      const params = z.object({ ...baseUser, query: z.string(), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args);
      const hits = memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit)
        .filter((hit) => ["bug_finding", "debug_trace", "fix_summary", "verification_result", "failed_attempt"].includes(hit.type));
      return toolResult(hits);
    }
    case "memory_failed_attempts": {
      const params = z.object({ ...baseUser, query: z.string(), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args);
      const hits = memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit)
        .filter((hit) => hit.type === "failed_attempt");
      return toolResult(hits);
    }
    case "memory_file_history": {
      const params = z.object({ ...baseUser, filePath: z.string(), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args);
      return toolResult(memoryEngine.getMemoriesByFilePath(effectiveUserId(params.userId, options?.defaultUserId), params.filePath, params.limit));
    }
    case "memory_task_state": {
      const params = z.object({ ...baseUser, query: z.string().optional().default("task state handover blocked next actions"), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args ?? {});
      const hits = memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit)
        .filter((hit) => ["task_state", "handover_note", "blocked_reason"].includes(hit.type));
      return toolResult(hits);
    }
    case "memory_task_update": {
      const params = z.object({
        ...baseUser,
        sessionKey: z.string().optional(),
        activeSkill: z.string().optional(),
        status: z.string().min(1),
        completed: stringList,
        blockers: stringList,
        nextActions: stringList,
        filePaths: stringList,
      }).parse(args);
      const userId = effectiveUserId(params.userId, options?.defaultUserId);
      const record = memoryEngine.upsertEngineeringMemory({
        userId,
        sessionKey: params.sessionKey,
        activeSkill: params.activeSkill,
        type: params.blockers.length > 0 ? "blocked_reason" : "task_state",
        content: [
          `Task status: ${params.status}`,
          params.completed.length ? `Completed: ${params.completed.join("; ")}` : "",
          params.blockers.length ? `Blockers: ${params.blockers.join("; ")}` : "",
          params.nextActions.length ? `Next actions: ${params.nextActions.join("; ")}` : "",
        ].filter(Boolean).join(". "),
        priority: params.blockers.length > 0 ? 85 : 80,
        filePaths: params.filePaths,
        metadata: {
          completed: params.completed,
          blockers: params.blockers,
          nextActions: params.nextActions,
        },
      });
      return toolResult(record);
    }
    case "memory_handover": {
      const params = z.object({ ...baseUser, query: z.string().optional().default("handover task state next actions"), limit: z.number().int().min(1).max(50).optional().default(10) }).parse(args ?? {});
      const hits = memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit)
        .filter((hit) => ["task_state", "handover_note", "blocked_reason", "fix_summary", "verification_result"].includes(hit.type));
      return toolResult({
        handover: hits.map((hit) => `- [${hit.type}] ${hit.content}`).join("\n"),
        records: hits,
      });
    }
    case "memory_verify": {
      const params = z.object({
        ...baseUser,
        recordId: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        status: z.enum(["active", "superseded", "archived", "needs_verification"]).optional(),
        verificationStatus: z.enum(["", "verified", "unverified", "stale"]).optional(),
        note: z.string().optional(),
      }).parse(args);
      const uid = effectiveUserId(params.userId, options?.defaultUserId);
      // Apply a verification update only when a mutable field was supplied;
      // otherwise this is a read-only provenance inspection.
      const hasUpdate =
        params.confidence !== undefined || params.status !== undefined ||
        params.verificationStatus !== undefined || params.note !== undefined;
      const record = hasUpdate
        ? memoryEngine.updateMemory(uid, params.recordId, {
            confidence: params.confidence,
            status: params.status,
            verificationStatus: params.verificationStatus,
            note: params.note,
          })
        : memoryEngine.getMemoryById(uid, params.recordId);
      // MEM-3 — the source chunks this record was distilled from.
      return toolResult({ record, sources: memoryEngine.getRecordProvenance(uid, params.recordId) });
    }
    default:
      throw new Error(`Unknown engineering memory tool: ${name}`);
  }
}
