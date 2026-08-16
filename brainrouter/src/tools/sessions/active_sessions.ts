/**
 * Active-session MCP registration and presence tools.
 *
 * Authenticated tenant/claim context is server-owned, and every caller-supplied
 * exact session key uses the same bounded control-free identity contract as
 * local messaging before it can reach storage or connection ownership.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../../memory/engine.js";
import { requireSessionKey } from "@kinqs/brainrouter-core/session";
import {
  type ActiveSessionClaim,
  type ActiveSessionUsage,
} from "@kinqs/brainrouter-types";

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

function connectionClaim(claimToken: string | undefined): ActiveSessionClaim | undefined {
  if (!claimToken) return undefined;
  return { token: claimToken };
}

const exactSessionKeySchema = z.string().superRefine((value, context) => {
  try {
    requireSessionKey(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid exact session key" });
  }
});

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
          "Client self-report. First-party kinds identify BrainRouter CLI or Desktop; custom values remain display metadata only.",
      },
      workspaceRoot: { type: "string", description: "Absolute workspace path; '' when unknown." },
      deviceId: { type: "string", description: "Persisted install UUID for display and route merging; never used as an address." },
      title: { type: "string", description: "Human-readable discovery label; never used for routing." },
      titleSource: { type: "string", enum: ["derived", "agent", "hook", "human"] },
      state: { type: "string", enum: ["idle", "working", "waiting"] },
      metadata: { type: "object", description: "Free-form per-client metadata." },
      messageWakeVersion: {
        type: "number",
        enum: [1],
        description: "Advertise support for the ADR-034 message-id MCP wake notification.",
      },
      usage: {
        type: "object",
        description: "Optional initial usage snapshot (tokens / USD).",
      },
    },
  },
} as const;

const sessionRegisterSchema = z.object({
  userId: z.string().optional(),
  sessionKey: exactSessionKeySchema.optional(),
  clientKind: z.string().optional(),
  workspaceRoot: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(60).refine((value) => !/[\r\n]/.test(value), "title must be one line").optional(),
  titleSource: z.enum(["derived", "agent", "hook", "human"]).optional(),
  state: z.enum(["idle", "working", "waiting"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  messageWakeVersion: z.literal(1).optional(),
  usage: usageSchema,
});

export async function handleSessionRegister(
  args: any,
  options?: {
    defaultUserId?: string;
    defaultOrgId?: string;
    /** Server-minted identity for this MCP transport; never tool-controlled. */
    claimToken?: string;
    onRegistered?: (
      orgId: string | null,
      userId: string,
      sessionKey: string,
      messageWakeVersion: 1 | undefined,
      registrationAttemptId: string,
    ) => void | Promise<void>;
    authorizeRegistration?: (
      orgId: string | null,
      userId: string,
      sessionKey: string,
      registrationAttemptId: string,
    ) => boolean | Promise<boolean>;
    onRegistrationFailed?: (
      orgId: string | null,
      userId: string,
      sessionKey: string,
      registrationAttemptId: string,
    ) => void | Promise<void>;
  },
) {
  let reserved: {
    orgId: string | null;
    userId: string;
    sessionKey: string;
    registrationAttemptId: string;
    claimPersisted: boolean;
  } | undefined;
  try {
    const params = sessionRegisterSchema.parse(args ?? {});
    const effectiveUserId = options?.defaultUserId ?? params.userId ?? "default";
    const effectiveOrgId = options?.defaultOrgId?.trim() || null;
    const now = new Date().toISOString();
    const sessionKey = params.sessionKey ?? randomUUID();
    const registrationAttemptId = randomUUID();
    if (options?.authorizeRegistration && !await options.authorizeRegistration(
      effectiveOrgId,
      effectiveUserId,
      sessionKey,
      registrationAttemptId,
    )) {
      throw new Error("this live session key is already bound to another MCP connection");
    }
    if (options?.authorizeRegistration) {
      reserved = {
        orgId: effectiveOrgId,
        userId: effectiveUserId,
        sessionKey,
        registrationAttemptId,
        claimPersisted: false,
      };
    }
    const registration = {
      sessionKey,
      orgId: effectiveOrgId,
      userId: effectiveUserId,
      clientKind: params.clientKind ?? "http-unknown",
      workspaceRoot: params.workspaceRoot ?? "",
      startedAt: now,
      lastHeartbeatAt: now,
      metadata: {
        ...(params.metadata ?? {}),
        deviceId: params.deviceId,
        title: params.title,
        titleSource: params.titleSource,
        state: params.state,
        messageWakeVersion: params.messageWakeVersion,
      },
      usage: withUpdatedAt(params.usage, now),
    };
    const claim = connectionClaim(options?.claimToken);
    const record = claim
      ? await memoryEngine.store.registerActiveSession(registration, claim)
      : await memoryEngine.store.registerActiveSession(registration);
    if (reserved) reserved.claimPersisted = options?.claimToken !== undefined;
    await options?.onRegistered?.(
      effectiveOrgId,
      effectiveUserId,
      record.sessionKey,
      params.messageWakeVersion,
      registrationAttemptId,
    );
    return toolResult({ session: record });
  } catch (err) {
    if (reserved) {
      if (reserved.claimPersisted && options?.claimToken) {
        try {
          await memoryEngine.store.unregisterActiveSession(
            reserved.userId,
            reserved.sessionKey,
            reserved.orgId,
            options.claimToken,
          );
        } catch { /* the renewable lease remains the crash cleanup path */ }
      }
      try {
        await options?.onRegistrationFailed?.(
          reserved.orgId,
          reserved.userId,
          reserved.sessionKey,
          reserved.registrationAttemptId,
        );
      } catch { /* the connection teardown remains a second cleanup path */ }
    }
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
  sessionKey: exactSessionKeySchema,
  usage: usageSchema,
});

export async function handleSessionHeartbeat(
  args: any,
  options?: {
    defaultUserId?: string;
    defaultOrgId?: string;
    claimToken?: string;
    authorizeSession?: (orgId: string | null, userId: string, sessionKey: string) => boolean | Promise<boolean>;
  },
) {
  try {
    const params = sessionHeartbeatSchema.parse(args ?? {});
    const effectiveUserId = options?.defaultUserId ?? params.userId ?? "default";
    const effectiveOrgId = options?.defaultOrgId?.trim() || null;
    if (options?.authorizeSession && !await options.authorizeSession(effectiveOrgId, effectiveUserId, params.sessionKey)) {
      throw new Error("the authenticated MCP connection does not own this session key");
    }
    const now = new Date().toISOString();
    const claim = connectionClaim(options?.claimToken);
    const heartbeatArgs = [
      effectiveUserId,
      params.sessionKey,
      now,
      withUpdatedAt(params.usage, now) ?? null,
      effectiveOrgId,
    ] as const;
    const updated = claim
      ? await memoryEngine.store.heartbeatActiveSession(...heartbeatArgs, claim)
      : await memoryEngine.store.heartbeatActiveSession(...heartbeatArgs);
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
  sessionKey: exactSessionKeySchema,
});

export async function handleSessionUnregister(
  args: any,
  options?: {
    defaultUserId?: string;
    defaultOrgId?: string;
    claimToken?: string;
    onUnregistered?: (orgId: string | null, userId: string, sessionKey: string) => void | Promise<void>;
    authorizeSession?: (orgId: string | null, userId: string, sessionKey: string) => boolean | Promise<boolean>;
  },
) {
  try {
    const params = sessionUnregisterSchema.parse(args ?? {});
    const effectiveUserId = options?.defaultUserId ?? params.userId ?? "default";
    const effectiveOrgId = options?.defaultOrgId?.trim() || null;
    if (options?.authorizeSession && !await options.authorizeSession(effectiveOrgId, effectiveUserId, params.sessionKey)) {
      throw new Error("the authenticated MCP connection does not own this session key");
    }
    const deleted = options?.claimToken
      ? await memoryEngine.store.unregisterActiveSession(
          effectiveUserId,
          params.sessionKey,
          effectiveOrgId,
          options.claimToken,
        )
      : await memoryEngine.store.unregisterActiveSession(effectiveUserId, params.sessionKey, effectiveOrgId);
    try { await options?.onUnregistered?.(effectiveOrgId, effectiveUserId, params.sessionKey); } catch { /* best effort */ }
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

export async function handleSessionList(args: any, options?: { defaultUserId?: string; defaultOrgId?: string }) {
  try {
    const params = sessionListSchema.parse(args ?? {});
    const effectiveUserId = options?.defaultUserId ?? params.userId ?? "default";
    const sessions = await memoryEngine.store.listActiveSessions({
      userId: effectiveUserId,
      orgId: options?.defaultOrgId?.trim() || null,
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
