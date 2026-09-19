import { z } from "zod";
import { memoryEngine } from "../../../memory/engine.js";
import { hasLearnedMemoryMetadata } from "../../../memory/util/learned-record.js";

const baseUser = { userId: z.string().optional() };

function effectiveUserId(userId: string | undefined, defaultUserId?: string): string {
  return userId ?? defaultUserId ?? "default";
}

function toolResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const stringList = z.array(z.string()).optional().default([]);

/**
 * Where the caller is asking FROM. Optional, because a caller that cannot say
 * still gets answers — but one that can say gets its own repo first.
 */
const callerScope = {
  workspaceTag: z.string().optional(),
  sessionKey: z.string().optional(),
};

/**
 * Rank by provenance: this session, then this workspace, then records that
 * never carried a workspace, then everything else.
 *
 * PREFER, never hide. These reads used to be a plain user-wide search, so a
 * `handover_note` written in a personal session — "submitted resignation,
 * update LinkedIn" — could outrank the repository the question was about and
 * be injected as authoritative context into a codebase session. Filtering it
 * out entirely would also lose the cross-repo lesson that is occasionally
 * exactly what you want; ordering it last, and marking where it came from,
 * loses neither.
 */
export type ScopeMatch = "session" | "workspace" | "untagged" | "other-workspace";

/** The two shapes these reads return: FTS rows are snake_case, records camelCase. */
function provenanceOf(hit: unknown): { workspaceTag?: string | null; sessionKey?: string | null } {
  const row = (hit ?? {}) as Record<string, unknown>;
  const pick = (a: string, b: string): string | null | undefined => {
    const value = row[a] ?? row[b];
    return typeof value === "string" || value === null ? value : undefined;
  };
  return { workspaceTag: pick("workspaceTag", "workspace_tag"), sessionKey: pick("sessionKey", "session_key") };
}

export function scopeMatchOf(hit: unknown, scope: { workspaceTag?: string; sessionKey?: string }): ScopeMatch {
  const { workspaceTag, sessionKey } = provenanceOf(hit);
  if (scope.sessionKey && sessionKey === scope.sessionKey) return "session";
  if (scope.workspaceTag && workspaceTag === scope.workspaceTag) return "workspace";
  // A record with no workspace predates tagging (or was captured without a
  // workspace); it belongs to everywhere, so it sits above another repo's.
  if (!workspaceTag) return "untagged";
  return "other-workspace";
}

const SCOPE_ORDER: Record<ScopeMatch, number> = {
  session: 0, workspace: 1, untagged: 2, "other-workspace": 3,
};

export function preferCallerScope<T>(
  hits: readonly T[],
  scope: { workspaceTag?: string; sessionKey?: string },
): Array<T & { scopeMatch: ScopeMatch }> {
  return hits
    .map((hit) => ({ ...hit, scopeMatch: scopeMatchOf(hit, scope) }))
    // Stable within a rank: the search's own relevance order is preserved.
    .sort((a, b) => SCOPE_ORDER[a.scopeMatch] - SCOPE_ORDER[b.scopeMatch]);
}

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
    description:
      "Read current task or handover state. Pass workspaceTag and sessionKey to put THIS repo's and " +
      "THIS session's records first — without them the search spans every workspace you have, and a " +
      "handover note from an unrelated session can outrank the one you meant. Nothing is ever hidden: " +
      "each hit carries scopeMatch (session | workspace | untagged | other-workspace).",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        workspaceTag: { type: "string", description: "16-char hash from workspaceTagFromPath — rank this workspace's records first." },
        sessionKey: { type: "string", description: "Rank this session's own task state above every other." },
      },
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
    description:
      "Generate a compact continuation note from current task memories. Pass workspaceTag/sessionKey to " +
      "rank this repo's and this session's records first (nothing is hidden; see scopeMatch).",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" }, query: { type: "string" }, limit: { type: "number" },
        workspaceTag: { type: "string" }, sessionKey: { type: "string" },
      },
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
      return toolResult({ records: await Promise.all(records) });
    }
    case "memory_debug_trace_search": {
      const params = z.object({ ...baseUser, query: z.string(), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args);
      const hits = (await memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit))
        .filter((hit) => ["bug_finding", "debug_trace", "fix_summary", "verification_result", "failed_attempt"].includes(hit.type));
      return toolResult(hits);
    }
    case "memory_failed_attempts": {
      const params = z.object({ ...baseUser, ...callerScope, query: z.string(), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args);
      const hits = (await memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit))
        .filter((hit) => hit.type === "failed_attempt");
      return toolResult(preferCallerScope(hits, params));
    }
    case "memory_file_history": {
      // A bare path is ambiguous across repos — every repository has an
      // AGENT.md — so this one especially needs to know where it was asked.
      const params = z.object({ ...baseUser, ...callerScope, filePath: z.string(), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args);
      const hits = await memoryEngine.getMemoriesByFilePath(effectiveUserId(params.userId, options?.defaultUserId), params.filePath, params.limit);
      return toolResult(preferCallerScope(hits, params));
    }
    case "memory_task_state": {
      const params = z.object({ ...baseUser, ...callerScope, query: z.string().optional().default("task state handover blocked next actions"), limit: z.number().int().min(1).max(100).optional().default(20) }).parse(args ?? {});
      const hits = (await memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit))
        .filter((hit) => ["task_state", "handover_note", "blocked_reason"].includes(hit.type));
      return toolResult(preferCallerScope(hits, params));
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
      const params = z.object({ ...baseUser, ...callerScope, query: z.string().optional().default("handover task state next actions"), limit: z.number().int().min(1).max(50).optional().default(10) }).parse(args ?? {});
      const hits = preferCallerScope(
        (await memoryEngine.searchMemoryRecords(effectiveUserId(params.userId, options?.defaultUserId), params.query, params.limit))
          .filter((hit) => ["task_state", "handover_note", "blocked_reason", "fix_summary", "verification_result"].includes(hit.type)),
        params,
      );
      return toolResult({
        // A continuation note that silently mixes in another repo's handover is
        // worse than one that says which repo each line came from.
        handover: hits
          .map((hit) => `- [${hit.type}]${hit.scopeMatch === "other-workspace" ? " (another workspace)" : ""} ${hit.content}`)
          .join("\n"),
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
      const existing = await memoryEngine.getMemoryById(uid, params.recordId);
      if (hasLearnedMemoryMetadata(existing)) {
        throw new Error("memory_verify is unavailable for learned memory records");
      }
      const record = hasUpdate
        ? await memoryEngine.updateMemory(uid, params.recordId, {
            confidence: params.confidence,
            status: params.status,
            verificationStatus: params.verificationStatus,
            note: params.note,
          })
        : existing;
      // MEM-3 — the source chunks this record was distilled from.
      return toolResult({ record, sources: await memoryEngine.getRecordProvenance(uid, params.recordId) });
    }
    default:
      throw new Error(`Unknown engineering memory tool: ${name}`);
  }
}
