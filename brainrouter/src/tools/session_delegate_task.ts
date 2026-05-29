import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";
import { resolveDelegationPeer, buildDelegationPacket } from "./delegation-helpers.js";

// Re-export the pure helpers so existing importers keep working; their
// implementations live in delegation-helpers.ts (sqlite-free, vitest-able).
export { resolveDelegationPeer, buildDelegationPacket } from "./delegation-helpers.js";

/**
 * Federation Stage 5 (0.4.2) — cross-vendor delegation MCP surface.
 *
 *   - `session_delegate_task` — package a normalized {@link DelegationPacket}
 *     and route it to an idle peer of the requested `agentKind`
 *     (delivered on the `delegate` inbox kind), or — when no peer is idle —
 *     park it in the `pending_delegations` queue for later claim.
 *   - `session_delegations`    — receive side: `list` pending delegations
 *     addressed at your kind, or `claim` the oldest one (atomically flips
 *     it to `claimed` for your sessionKey and returns the packet).
 *
 * Vendor-neutral by design: the packet carries everything a peer needs to
 * act regardless of which CLI/agent originated it. Translating the packet
 * into a vendor-specific prompt/goal is the receiver's job (the CLI's
 * `orchestration/delegation.ts` adapters).
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
  };
}

// ── session_delegate_task ─────────────────────────────────────────────────

export const sessionDelegateTaskToolSchema = {
  name: "session_delegate_task",
  description:
    "Delegate a self-contained task to a peer of a given vendor/agent kind (cross-vendor). Resolves `agentKind` to the idlest active peer and delivers the normalized delegation packet on the `delegate` inbox kind; if no peer of that kind is currently active, the packet is parked in the pending-delegations queue for later claim. Returns { routed, to?, deliveredIds?, pendingId? }.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      from: { type: "string", description: "Sender sessionKey." },
      agentKind: {
        type: "string",
        description: "Target vendor/agent kind, e.g. `codex`, `claude-code`, `brainrouter-cli`.",
      },
      payload: {
        type: "object",
        description:
          "Delegation packet fields: { goal, files?, constraints?, modelHints?, budget?, deadline?, note?, originatingClient?, originatingWorkspace? }. `goal` is required.",
      },
    },
    required: ["from", "agentKind", "payload"],
  },
} as const;

const sessionDelegateTaskSchema = z.object({
  userId: z.string().optional(),
  from: z.string(),
  agentKind: z.string().min(1),
  payload: z.record(z.unknown()),
});

export async function handleSessionDelegateTask(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionDelegateTaskSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const now = new Date().toISOString();
    const packet = buildDelegationPacket(params.from, params.payload, now);
    if (!packet.goal) {
      return toolError("session_delegate_task", new Error("payload.goal is required"));
    }

    const sessions = memoryEngine.store.listActiveSessions({ userId, clientKind: params.agentKind });
    const peer = resolveDelegationPeer(sessions, params.agentKind, params.from);

    if (peer) {
      const rows = memoryEngine.store.sendSessionMessage({
        userId,
        fromSessionKey: params.from,
        toSessionKey: peer,
        kind: "delegate",
        payload: packet as unknown as Record<string, unknown>,
      });
      return toolResult({ routed: true, to: peer, deliveredIds: rows.map((r) => r.id) });
    }

    const pending = memoryEngine.store.enqueuePendingDelegation({
      userId,
      fromSessionKey: params.from,
      toAgentKind: params.agentKind.trim().toLowerCase(),
      packet,
    });
    return toolResult({ routed: false, queued: true, pendingId: pending.id });
  } catch (err) {
    return toolError("session_delegate_task", err);
  }
}

// ── session_delegations (receive side) ────────────────────────────────────

export const sessionDelegationsToolSchema = {
  name: "session_delegations",
  description:
    "Receive side for cross-vendor delegation. action `list` returns pending delegations addressed at `agentKind`; action `claim` atomically takes the oldest pending one for your `sessionKey` and returns its packet (or { claimed: null } if none).",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      action: { type: "string", enum: ["list", "claim"] },
      agentKind: { type: "string", description: "Your vendor/agent kind." },
      sessionKey: { type: "string", description: "Your sessionKey (required for `claim`)." },
      limit: { type: "number" },
    },
    required: ["action", "agentKind"],
  },
} as const;

const sessionDelegationsSchema = z.object({
  userId: z.string().optional(),
  action: z.enum(["list", "claim"]),
  agentKind: z.string().min(1),
  sessionKey: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export async function handleSessionDelegations(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = sessionDelegationsSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const kind = params.agentKind.trim().toLowerCase();

    if (params.action === "list") {
      const pending = memoryEngine.store.listPendingDelegations({
        userId,
        toAgentKind: kind,
        status: "pending",
        limit: params.limit,
      });
      return toolResult({ pending });
    }

    if (!params.sessionKey) {
      return toolError("session_delegations", new Error("sessionKey is required for action `claim`"));
    }
    const claimed = memoryEngine.store.claimPendingDelegation(
      userId,
      kind,
      params.sessionKey,
      new Date().toISOString(),
    );
    return toolResult({ claimed });
  } catch (err) {
    return toolError("session_delegations", err);
  }
}
