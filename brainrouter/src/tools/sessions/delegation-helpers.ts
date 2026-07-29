import { buildCrossHostDelegationPacket } from "@kinqs/brainrouter-core/orchestration/delegation-contracts";
import type { ActiveSessionRecord } from "@kinqs/brainrouter-types";
import type { DelegationPacket } from "@kinqs/brainrouter-types/agent";

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

/**
 * Normalize loosely typed transport input into the canonical bounded packet.
 *
 * Legacy callers remain readable, but receive a read-only, tool-free handoff.
 * A supplied canonical task packet is re-bounded by Core before persistence.
 */
export function buildDelegationPacket(
  from: string,
  payload: Record<string, unknown>,
  now: string,
): DelegationPacket {
  return buildCrossHostDelegationPacket(from, payload, now);
}
