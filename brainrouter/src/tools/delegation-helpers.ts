import type { ActiveSessionRecord, DelegationPacket } from "@kinqs/brainrouter-types";

/**
 * FED-S5 (0.4.2) — pure delegation helpers, kept free of any
 * `memoryEngine`/`node:sqlite` import so they unit-test under vitest
 * (the tool handler that uses the store is node-test-only).
 */

/**
 * The idlest active peer of `agentKind` (oldest heartbeat), excluding the
 * sender. Returns null when none match.
 */
export function resolveDelegationPeer(
  sessions: Pick<ActiveSessionRecord, "sessionKey" | "clientKind" | "lastHeartbeatAt">[],
  agentKind: string,
  fromSessionKey: string,
): string | null {
  const kind = agentKind.trim().toLowerCase();
  const candidates = sessions
    .filter((s) => (s.clientKind ?? "").toLowerCase() === kind && s.sessionKey !== fromSessionKey)
    .sort((a, b) => Date.parse(a.lastHeartbeatAt ?? "0") - Date.parse(b.lastHeartbeatAt ?? "0"));
  return candidates[0]?.sessionKey ?? null;
}

/** Normalize loosely-typed tool args into a full DelegationPacket. */
export function buildDelegationPacket(
  from: string,
  payload: Record<string, unknown>,
  now: string,
): DelegationPacket {
  const asStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const budget =
    payload.budget && typeof payload.budget === "object"
      ? (payload.budget as { tokens?: number; usd?: number })
      : null;
  return {
    goal: String(payload.goal ?? "").trim(),
    fromSessionKey: from,
    originatingClient: String(payload.originatingClient ?? "unknown"),
    originatingWorkspace: String(payload.originatingWorkspace ?? ""),
    files: asStrArray(payload.files),
    constraints: asStrArray(payload.constraints),
    modelHints: asStrArray(payload.modelHints),
    budget,
    deadline: typeof payload.deadline === "string" ? payload.deadline : null,
    note: typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : undefined,
    createdAt: now,
  };
}
