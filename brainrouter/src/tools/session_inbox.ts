import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";
import type { SessionInboxKind } from "@kinqs/brainrouter-types";

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

const inboxKindEnum: readonly SessionInboxKind[] = [
  "text",
  "tool-result",
  "memory-ref",
  "goal-handoff",
  "delegate",
];

// ── session_send ────────────────────────────────────────────────────────

export const sessionSendToolSchema = {
  name: "session_send",
  description:
    "Send a message to another active session under your userId. `to` may be a literal sessionKey, `<clientKind>:*` for pattern broadcast, or `*` for full broadcast. Broadcast forms fan out at send time and only reach sessions whose last heartbeat is within the active window (2 min). Returns the per-recipient inbox ids so callers can show 'delivered to N peers' feedback.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      from: { type: "string", description: "Sender sessionKey. Required so the recipient knows who sent it." },
      to: { type: "string", description: "Address: sessionKey, '<clientKind>:*', or '*'." },
      kind: {
        type: "string",
        enum: [...inboxKindEnum],
        description: "Payload kind. Only `text` is rendered by 0.4.0 CLIs; the others are reserved for Stage 4 + multi-agent Phase 2.",
      },
      payload: {
        type: "object",
        description: "Free-form per-kind payload. For `text`, `{ text: '...' }`.",
      },
    },
    required: ["from", "to", "kind"],
  },
} as const;

const sessionSendSchema = z.object({
  userId: z.string().optional(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(["text", "tool-result", "memory-ref", "goal-handoff", "delegate"]),
  payload: z.record(z.unknown()).optional(),
});

export async function handleSessionSend(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionSendSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const rows = memoryEngine.store.sendSessionMessage({
      userId: effectiveUserId,
      fromSessionKey: params.from,
      toSessionKey: params.to,
      kind: params.kind,
      payload: params.payload ?? {},
    });
    return toolResult({
      delivered: rows.length,
      ids: rows.map((r) => r.id),
    });
  } catch (err) {
    return toolError("session_send", err);
  }
}

// ── session_inbox_read ──────────────────────────────────────────────────

export const sessionInboxReadToolSchema = {
  name: "session_inbox_read",
  description:
    "Pull undelivered messages for the given session. By default, marks them delivered atomically on the way out. Pass `peek: true` to inspect without acknowledging — the caller is then responsible for calling `session_inbox_ack` for the ids it actually consumed (lets a crashy reader replay safely).",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string", description: "Recipient session." },
      peek: { type: "boolean", description: "When true, returns messages without marking delivered. Default false." },
      includeDelivered: { type: "boolean", description: "When true, also returns previously-acked rows. Default false." },
      limit: { type: "number", description: "Max rows to return; default 50, capped at 200." },
    },
    required: ["sessionKey"],
  },
} as const;

const sessionInboxReadSchema = z.object({
  userId: z.string().optional(),
  sessionKey: z.string(),
  peek: z.boolean().optional(),
  includeDelivered: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export async function handleSessionInboxRead(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionInboxReadSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const messages = memoryEngine.store.readSessionInbox({
      userId: effectiveUserId,
      toSessionKey: params.sessionKey,
      includeDelivered: params.includeDelivered,
      limit: params.limit,
    });
    if (!params.peek && messages.length > 0) {
      const ids = messages.filter((m) => m.deliveredAt === null).map((m) => m.id);
      if (ids.length > 0) {
        memoryEngine.store.ackSessionInbox(
          effectiveUserId,
          params.sessionKey,
          ids,
          new Date().toISOString(),
        );
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
    "Mark specific inbox ids as delivered. Idempotent — already-delivered ids are silently skipped. Use after `session_inbox_read` with `peek: true` once the caller has actually persisted / surfaced the message.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      sessionKey: { type: "string", description: "Recipient session whose inbox to ack into." },
      ids: { type: "array", items: { type: "string" }, description: "Inbox ids to mark delivered." },
    },
    required: ["sessionKey", "ids"],
  },
} as const;

const sessionInboxAckSchema = z.object({
  userId: z.string().optional(),
  sessionKey: z.string(),
  ids: z.array(z.string()).max(500),
});

export async function handleSessionInboxAck(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionInboxAckSchema.parse(args ?? {});
    const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
    const acked = memoryEngine.store.ackSessionInbox(
      effectiveUserId,
      params.sessionKey,
      params.ids,
      new Date().toISOString(),
    );
    return toolResult({ acked });
  } catch (err) {
    return toolError("session_inbox_ack", err);
  }
}
