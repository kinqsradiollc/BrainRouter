/**
 * Durable session-message MCP tools.
 *
 * Tenant and claim authority is server-pinned, exact routing keys share the
 * local bounded control-free identity contract, and persistence/receipt states
 * never imply recipient application before its explicit transition.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../../memory/engine.js";
import { requireSessionKey } from "@kinqs/brainrouter-core/session";
import {
  SESSION_MESSAGE_STATUSES,
  type SessionInboxKind,
  type SessionInboxRecord,
} from "@kinqs/brainrouter-types";

const MAX_SESSION_TEXT_BYTES = 20_000;
const MAX_SESSION_PAYLOAD_BYTES = 64 * 1024;

type WakeOutcome = "pushed" | "poll-fallback";

interface SessionToolOptions {
  defaultUserId?: string;
  defaultOrgId?: string;
  /** Server-minted identity for this MCP transport; never tool-controlled. */
  claimToken?: string;
  authorizeSession?: (
    orgId: string | null,
    userId: string,
    sessionKey: string,
  ) => boolean | Promise<boolean>;
  onPersisted?: (rows: SessionInboxRecord[]) => Promise<Map<string, WakeOutcome>>;
}

/**
 * Federation Stage 3 (0.4.0) — cross-CLI messaging MCP surface.
 *
 *   - `session_send`        — write a message into one or more
 *                              recipient sessions' inboxes.
 *   - `session_inbox_read`  — pull undelivered messages for a session,
 *                              optionally peek without marking delivered.
 *   - `session_inbox_ack`   — explicitly stamp delivered for a list of
 *                              inbox ids (covers the peek + later-ack
 *                              workflow).
 *
 * `kind` accepts all five enum values today; only `text` is wired
 * end-to-end through the CLI in Stage 3. The other kinds
 * (`tool-result`, `memory-ref`, `goal-handoff`, `delegate`) are
 * schema-reserved so Stage 4 + CLI Multi-Agent Phase 2 can carry
 * structured payloads without a follow-up migration.
 *
 * `session_send` accepts three addressing shapes for `to`:
 *   - exact `sessionKey`              — point-to-point
 *   - `<clientKind>:*`                — broadcast to that kind
 *   - `*` (or `"broadcast"`)          — broadcast to every active peer
 *
 * Broadcast forms only reach sessions whose `last_heartbeat_at` is
 * within the active window (2 min). Sending into the past has no
 * useful semantics — a stale peer can't read its inbox.
 */

function toolResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
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

const inboxKindEnum: readonly SessionInboxKind[] = [
  "text",
  "tool-result",
  "memory-ref",
  "goal-handoff",
  "delegate",
];

const exactSessionKeySchema = z.string().superRefine((value, context) => {
  try {
    requireSessionKey(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid exact session key" });
  }
});

const sessionAddressSchema = z.string().superRefine((value, context) => {
  if (value === "*" || value.toLowerCase() === "broadcast") return;
  const kindPattern = /^([^:]+):\*$/.exec(value);
  try {
    requireSessionKey(kindPattern?.[1] ?? value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid session address" });
  }
});

function effectiveTenant(
  paramsUserId: string | undefined,
  options: Pick<SessionToolOptions, "defaultUserId" | "defaultOrgId"> | undefined,
): { orgId: string | null; userId: string } {
  return {
    orgId: options?.defaultOrgId?.trim() || null,
    // Authenticated transports pin the user. The request field remains only
    // for local stdio/backward-compatible administrative callers.
    userId: options?.defaultUserId ?? paramsUserId ?? "default",
  };
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const text = payload.text;
  if (typeof text === "string" && Buffer.byteLength(text, "utf8") > MAX_SESSION_TEXT_BYTES) {
    throw new Error(`text exceeds ${MAX_SESSION_TEXT_BYTES} UTF-8 bytes`);
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SESSION_PAYLOAD_BYTES) {
    throw new Error(`payload exceeds ${MAX_SESSION_PAYLOAD_BYTES} bytes`);
  }
  return payload;
}

// ── session_send ────────────────────────────────────────────────────────

export const sessionSendToolSchema = {
  name: "session_send",
  description:
    "Queue a message for another active session in the authenticated tenant. `to` may be a literal sessionKey, `<clientKind>:*` for pattern broadcast, or `*` for full broadcast. The result distinguishes durable acceptance from recipient application and reports whether a live push wake or polling fallback will carry each row. Zero matches and unknown exact keys are errors.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      messageId: {
        type: "string",
        description: "Sender-generated idempotency key. Retrying the same content with this id never duplicates it.",
      },
      from: { type: "string", description: "Sender sessionKey. Required so the recipient knows who sent it." },
      to: { type: "string", description: "Address: sessionKey, '<clientKind>:*', or '*'." },
      kind: {
        type: "string",
        enum: [...inboxKindEnum],
        description: "Payload kind. Only `text` is rendered by 0.4.0 CLIs; the others are reserved for Stage 4 + multi-agent Phase 2.",
      },
      payload: {
        type: "object",
        description: "Untrusted per-kind content. For `text`, `{ text: '...' }`; sender identity fields are ignored and replaced from the authenticated active-session row.",
      },
    },
    required: ["from", "to", "kind"],
  },
} as const;

const sessionSendSchema = z.object({
  userId: z.string().optional(),
  messageId: z.string().min(1).max(512).optional(),
  from: exactSessionKeySchema,
  to: sessionAddressSchema,
  kind: z.enum(["text", "tool-result", "memory-ref", "goal-handoff", "delegate"]),
  payload: z.record(z.unknown()).optional(),
});

export async function handleSessionSend(
  args: any,
  options?: SessionToolOptions,
) {
  try {
    const params = sessionSendSchema.parse(args ?? {});
    const tenant = effectiveTenant(params.userId, options);
    if (options?.authorizeSession && !await options.authorizeSession(tenant.orgId, tenant.userId, params.from)) {
      throw new Error("the authenticated MCP connection does not own the sender session key");
    }
    const result = await memoryEngine.store.routeSessionMessage({
      orgId: tenant.orgId,
      userId: tenant.userId,
      messageId: params.messageId ?? randomUUID(),
      fromSessionKey: params.from,
      toSessionKey: params.to,
      kind: params.kind,
      payload: boundedPayload(params.payload ?? {}),
      ...(options?.claimToken ? { senderClaimToken: options.claimToken } : {}),
    });
    let wakes = new Map<string, WakeOutcome>();
    try {
      wakes = await options?.onPersisted?.(result.deliveries) ?? wakes;
    } catch {
      // Persistence is authoritative. A failed wake is truthfully reported as
      // poll fallback and the recipient will replay the durable row.
    }
    const payload = {
      messageId: result.messageId,
      state: result.state,
      accepted: result.accepted,
      rejected: result.rejected,
      idempotentReplay: result.idempotentReplay,
      ...(result.rejectionReason ? { rejectionReason: result.rejectionReason } : {}),
      recipients: result.receipts.map((row) => ({
        sessionKey: row.toSessionKey,
        inboxId: row.id,
        status: row.status ?? "pending",
        ...(row.statusReason ? { reason: row.statusReason } : {}),
        ...(row.status === "pending" ? { wake: wakes.get(row.id) ?? "poll-fallback" } : {}),
      })),
    };
    return toolResult(payload, result.accepted === 0);
  } catch (err) {
    return toolError("session_send", err);
  }
}

// ── session_inbox_read ──────────────────────────────────────────────────

export const sessionInboxReadToolSchema = {
  name: "session_inbox_read",
  description:
    "Read messages for the given session without changing lifecycle state by default. After recipient admission, call `session_inbox_ack` with the truthful held/applied/rejected/expired state. `peek: false` retains the legacy read-and-apply behavior for callers that have already applied every returned row.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string", description: "Recipient session." },
      peek: { type: "boolean", description: "When true, returns messages without changing state. Default true; false is the legacy read-and-apply path." },
      includeDelivered: { type: "boolean", description: "When true, also returns previously-acked rows. Default false." },
      statuses: {
        type: "array",
        items: { type: "string", enum: [...SESSION_MESSAGE_STATUSES] },
        description: "Optional lifecycle states. Default is pending only.",
      },
      limit: { type: "number", description: "Max rows to return; default 50, capped at 200." },
    },
    required: ["sessionKey"],
  },
} as const;

const sessionInboxReadSchema = z.object({
  userId: z.string().optional(),
  sessionKey: exactSessionKeySchema,
  peek: z.boolean().optional(),
  includeDelivered: z.boolean().optional(),
  statuses: z.array(z.enum(SESSION_MESSAGE_STATUSES)).max(SESSION_MESSAGE_STATUSES.length).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export async function handleSessionInboxRead(
  args: any,
  options?: SessionToolOptions,
) {
  try {
    const params = sessionInboxReadSchema.parse(args ?? {});
    const tenant = effectiveTenant(params.userId, options);
    if (options?.authorizeSession && !await options.authorizeSession(tenant.orgId, tenant.userId, params.sessionKey)) {
      throw new Error("the authenticated MCP connection does not own the recipient session key");
    }
    const messages = await memoryEngine.store.readSessionInbox({
      orgId: tenant.orgId,
      userId: tenant.userId,
      toSessionKey: params.sessionKey,
      includeDelivered: params.includeDelivered,
      statuses: params.statuses,
      limit: params.limit,
      ...(options?.claimToken ? { claimToken: options.claimToken } : {}),
    });
    if (params.peek === false && messages.length > 0) {
      const ids = messages.filter((m) => m.deliveredAt === null).map((m) => m.id);
      if (ids.length > 0) {
        const ackArgs = [
          tenant.userId,
          params.sessionKey,
          ids,
          new Date().toISOString(),
          tenant.orgId,
        ] as const;
        if (options?.claimToken) {
          await memoryEngine.store.ackSessionInbox(...ackArgs, options.claimToken);
        } else {
          await memoryEngine.store.ackSessionInbox(...ackArgs);
        }
      }
    }
    return toolResult({ messages });
  } catch (err) {
    return toolError("session_inbox_read", err);
  }
}

// ── session_inbox_ack ───────────────────────────────────────────────────

export const sessionInboxAckToolSchema = {
  name: "session_inbox_ack",
  description:
    "Transition specific inbox receipts after recipient admission or application. Idempotent — rows already outside the allowed pending/held predecessor states are skipped. Use held before human review and applied only from the model-safe-boundary callback.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string", description: "Recipient session whose inbox to ack into." },
      ids: { type: "array", items: { type: "string" }, description: "Inbox ids to mark delivered." },
      status: {
        type: "string",
        enum: ["held", "applied", "rejected", "declined", "expired", "queue_full"],
        description: "Recipient lifecycle transition. Defaults to applied for legacy callers.",
      },
      reason: { type: "string", description: "Bounded human-readable reason for held/rejected/expired states." },
    },
    required: ["sessionKey", "ids"],
  },
} as const;

const sessionInboxAckSchema = z.object({
  userId: z.string().optional(),
  sessionKey: exactSessionKeySchema,
  ids: z.array(z.string()).max(500),
  status: z.enum(["held", "applied", "rejected", "declined", "expired", "queue_full"]).optional(),
  reason: z.string().max(512).optional(),
});

export async function handleSessionInboxAck(
  args: any,
  options?: SessionToolOptions,
) {
  try {
    const params = sessionInboxAckSchema.parse(args ?? {});
    const tenant = effectiveTenant(params.userId, options);
    if (options?.authorizeSession && !await options.authorizeSession(tenant.orgId, tenant.userId, params.sessionKey)) {
      throw new Error("the authenticated MCP connection does not own the recipient session key");
    }
    const rows = await memoryEngine.store.transitionSessionMessages({
      orgId: tenant.orgId,
      userId: tenant.userId,
      toSessionKey: params.sessionKey,
      ids: params.ids,
      toStatus: params.status ?? "applied",
      reason: params.reason,
      at: new Date().toISOString(),
      ...(options?.claimToken ? { claimToken: options.claimToken } : {}),
    });
    return toolResult({ updated: rows.length, status: params.status ?? "applied", messages: rows });
  } catch (err) {
    return toolError("session_inbox_ack", err);
  }
}

// ── sender-visible receipts ─────────────────────────────────────────────

export const sessionReceiptsToolSchema = {
  name: "session_receipts",
  description:
    "Read durable lifecycle receipts for messages sent by this authenticated session. Shows pending, held, applied, rejected, declined, queue-full, and expired outcomes; nothing is inferred from a wake notification.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string", description: "Sender session key owned by this MCP connection." },
      messageId: { type: "string", description: "Optional sender idempotency key filter." },
      statuses: { type: "array", items: { type: "string", enum: [...SESSION_MESSAGE_STATUSES] } },
      limit: { type: "number", description: "Maximum rows; default 100, capped at 500." },
    },
    required: ["sessionKey"],
  },
} as const;

const sessionReceiptsSchema = z.object({
  userId: z.string().optional(),
  sessionKey: exactSessionKeySchema,
  messageId: z.string().min(1).max(512).optional(),
  statuses: z.array(z.enum(SESSION_MESSAGE_STATUSES)).max(SESSION_MESSAGE_STATUSES.length).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export async function handleSessionReceipts(args: any, options?: SessionToolOptions) {
  try {
    const params = sessionReceiptsSchema.parse(args ?? {});
    const tenant = effectiveTenant(params.userId, options);
    if (options?.authorizeSession && !await options.authorizeSession(tenant.orgId, tenant.userId, params.sessionKey)) {
      throw new Error("the authenticated MCP connection does not own the sender session key");
    }
    const receipts = await memoryEngine.store.readSessionMessageReceipts({
      orgId: tenant.orgId,
      userId: tenant.userId,
      fromSessionKey: params.sessionKey,
      messageId: params.messageId,
      statuses: params.statuses,
      limit: params.limit,
      ...(options?.claimToken ? { claimToken: options.claimToken } : {}),
    });
    return toolResult({ receipts });
  } catch (err) {
    return toolError("session_receipts", err);
  }
}

export const sessionReceiptsAckToolSchema = {
  name: "session_receipts_ack",
  description:
    "Acknowledge terminal sender receipts after the host has surfaced them. Pending and held rows cannot be acknowledged or deleted early.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string" },
      ids: { type: "array", items: { type: "string" }, description: "Terminal inbox receipt ids." },
    },
    required: ["sessionKey", "ids"],
  },
} as const;

const sessionReceiptsAckSchema = z.object({
  userId: z.string().optional(),
  sessionKey: exactSessionKeySchema,
  ids: z.array(z.string().min(1).max(512)).max(500),
});

export async function handleSessionReceiptsAck(args: any, options?: SessionToolOptions) {
  try {
    const params = sessionReceiptsAckSchema.parse(args ?? {});
    const tenant = effectiveTenant(params.userId, options);
    if (options?.authorizeSession && !await options.authorizeSession(tenant.orgId, tenant.userId, params.sessionKey)) {
      throw new Error("the authenticated MCP connection does not own the sender session key");
    }
    const acknowledged = await memoryEngine.store.ackSessionMessageReceipts({
      orgId: tenant.orgId,
      userId: tenant.userId,
      fromSessionKey: params.sessionKey,
      ids: params.ids,
      at: new Date().toISOString(),
      ...(options?.claimToken ? { claimToken: options.claimToken } : {}),
    });
    return toolResult({ acknowledged });
  } catch (err) {
    return toolError("session_receipts_ack", err);
  }
}
