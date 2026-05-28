import { z } from "zod";
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../memory/engine.js";
import type { ActiveSessionUsage } from "@kinqs/brainrouter-types";

/**
 * Federation Stage 2 (0.4.0) — three MCP tools backing the active-session
 * registry:
 *
 *   - `session_register` — called once at client startup; returns a
 *     stable `sessionKey`. Idempotent: passing the client's own
 *     `sessionKey` re-registers without changing it.
 *   - `session_heartbeat` — called every ~30s to advance
 *     `lastHeartbeatAt`. Optional `usage` field updates the per-session
 *     cache/cost snapshot (FED-S2-T8). Must NOT write to operation_log
 *     — audit volume guard.
 *   - `session_list` — returns active peers; default filter scopes to
 *     heartbeats within the last 2 minutes.
 *
 * All three tools default to the `defaultUserId` resolved at request
 * time (matching `memory_recall` etc.).
 */

function toolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
  };
}

const usageSchema = z
  .object({
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    cachedPromptTokens: z.number().optional(),
    totalUsd: z.number().optional(),
    cacheSavingsUsd: z.number().optional(),
    updatedAt: z.string().optional(),
  })
  .optional();

function withUpdatedAt(
  usage: z.infer<typeof usageSchema>,
  fallback: string,
): ActiveSessionUsage | undefined {
  if (!usage) return undefined;
  return { ...usage, updatedAt: usage.updatedAt ?? fallback };
}

// ── session_register ────────────────────────────────────────────────────

export const sessionRegisterToolSchema = {
  name: "session_register",
  description:
    "Register an active MCP client with the brain. Called once at client startup. Returns a stable `sessionKey` you should pass to subsequent heartbeats — if you already have one, pass it back and the registry will preserve `startedAt` while refreshing client metadata.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User id; falls back to the default user." },
      sessionKey: {
        type: "string",
        description: "Optional stable id from the client. When omitted, the server mints one.",
      },
      clientKind: {
        type: "string",
        description:
          "Client self-report. Known kinds: `brainrouter-cli`, `claude-code`, `codex`, `cursor`, `gemini-cli`. Free-form; unknown values fall through.",
      },
      workspaceRoot: { type: "string", description: "Absolute workspace path; '' when unknown." },
      metadata: { type: "object", description: "Free-form per-client metadata." },
      usage: {
        type: "object",
        description: "Optional initial usage snapshot (tokens / USD).",
      },
    },
  },
} as const;

const sessionRegisterSchema = z.object({
  userId: z.string().optional(),
  sessionKey: z.string().optional(),
  clientKind: z.string().optional(),
  workspaceRoot: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  usage: usageSchema,
});

export async function handleSessionRegister(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionRegisterSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const now = new Date().toISOString();
    const sessionKey = params.sessionKey ?? randomUUID();
    const record = memoryEngine.store.registerActiveSession({
      sessionKey,
      userId: effectiveUserId,
      clientKind: params.clientKind ?? "http-unknown",
      workspaceRoot: params.workspaceRoot ?? "",
      startedAt: now,
      lastHeartbeatAt: now,
      metadata: params.metadata ?? {},
      usage: withUpdatedAt(params.usage, now),
    });
    return toolResult({ session: record });
  } catch (err) {
    return toolError("session_register", err);
  }
}

// ── session_heartbeat ───────────────────────────────────────────────────

export const sessionHeartbeatToolSchema = {
  name: "session_heartbeat",
  description:
    "Advance lastHeartbeatAt for an active session. Call every ~30s. Returns `{ updated: true }` on success; `{ updated: false }` when no row exists (client should re-register on that signal). Heartbeats deliberately do not write to the operation_log to keep audit volume bounded.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string", description: "The key returned from `session_register`." },
      usage: {
        type: "object",
        description: "Optional usage snapshot (last-write-wins).",
      },
    },
    required: ["sessionKey"],
  },
} as const;

const sessionHeartbeatSchema = z.object({
  userId: z.string().optional(),
  sessionKey: z.string(),
  usage: usageSchema,
});

export async function handleSessionHeartbeat(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionHeartbeatSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const now = new Date().toISOString();
    const updated = memoryEngine.store.heartbeatActiveSession(
      effectiveUserId,
      params.sessionKey,
      now,
      withUpdatedAt(params.usage, now) ?? null,
    );
    return toolResult({ updated, at: now });
  } catch (err) {
    return toolError("session_heartbeat", err);
  }
}

// ── session_unregister ──────────────────────────────────────────────────

export const sessionUnregisterToolSchema = {
  name: "session_unregister",
  description:
    "Remove an active session row immediately. Called by clients on clean exit so peers don't see a 5-min ghost while the sweeper catches up. Idempotent: returns `{ deleted: false }` when no matching row exists. Safe to call from a shutdown hook even when the brain may already be down — callers should swallow errors.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User id; falls back to the default user." },
      sessionKey: { type: "string", description: "The key returned from `session_register`." },
    },
    required: ["sessionKey"],
  },
} as const;

const sessionUnregisterSchema = z.object({
  userId: z.string().optional(),
  sessionKey: z.string(),
});

export async function handleSessionUnregister(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionUnregisterSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const deleted = memoryEngine.store.unregisterActiveSession(effectiveUserId, params.sessionKey);
    return toolResult({ deleted });
  } catch (err) {
    return toolError("session_unregister", err);
  }
}

// ── session_list ────────────────────────────────────────────────────────

export const sessionListToolSchema = {
  name: "session_list",
  description:
    "List active peer sessions for a user. Default scope is `last_heartbeat_at` within the last 2 minutes (recently-active peers). Pass `includeStale: true` to see every row in the registry, and `includeUsage: true` to include the per-session token / USD snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      clientKind: { type: "string" },
      workspaceRoot: { type: "string" },
      includeStale: { type: "boolean", description: "Default false — only active heartbeats." },
      staleThresholdMs: {
        type: "number",
        description: "Override the active-threshold in ms; default 120000 (2 min).",
      },
      includeUsage: {
        type: "boolean",
        description: "When true, include each session's usage snapshot (FED-S2-T8).",
      },
    },
  },
} as const;

const sessionListSchema = z.object({
  userId: z.string().optional(),
  clientKind: z.string().optional(),
  workspaceRoot: z.string().optional(),
  includeStale: z.boolean().optional(),
  staleThresholdMs: z.number().optional(),
  includeUsage: z.boolean().optional(),
});

export async function handleSessionList(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionListSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const sessions = memoryEngine.store.listActiveSessions({
      userId: effectiveUserId,
      clientKind: params.clientKind,
      workspaceRoot: params.workspaceRoot,
      includeStale: params.includeStale,
      staleThresholdMs: params.staleThresholdMs,
      includeUsage: params.includeUsage,
    });
    return toolResult({ sessions });
  } catch (err) {
    return toolError("session_list", err);
  }
}
