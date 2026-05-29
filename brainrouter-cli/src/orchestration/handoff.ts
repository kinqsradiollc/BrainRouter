/**
 * FED-S4 (0.4.1) — federation work handoff.
 *
 * `/handoff` packages the sender's current goal + recent context into a
 * `goal-handoff` inbox message addressed at another active session. The
 * receiver lists pending handoffs (`/handoff list`) and accepts one
 * (`/handoff accept`), which creates a fresh local goal from the packet.
 *
 * The packet reuses the MAS-P2 `ParentExecutionContextSnapshot` shape and
 * adds the three federation-specific fields the spec calls for
 * (`originatingClient`, `originatingWorkspace`, `recentTranscript`).
 *
 * This module is pure (no I/O) so the packet builder + target resolver
 * unit-test without a live brain.
 */

import type { ParentExecutionContextSnapshot } from "./parentContext.js";

export interface HandoffPacket {
  /** The goal/task text being handed off. */
  goal: string;
  /** Sender's federation sessionKey. */
  fromSessionKey: string;
  /** Sender's clientKind (e.g. `brainrouter-cli`, `codex`). */
  originatingClient: string;
  /** Sender's workspace root. */
  originatingWorkspace: string;
  /** A short tail of the sender's recent transcript for context. */
  recentTranscript: string;
  /** Optional free-text note from the sender. */
  note?: string;
  /** Reused parent-execution-context snapshot (goal/plan/recalled records/…). */
  snapshot?: Partial<ParentExecutionContextSnapshot>;
  /** ISO timestamp. */
  createdAt: string;
}

export function buildHandoffPacket(input: {
  goal: string;
  fromSessionKey: string;
  originatingClient: string;
  originatingWorkspace: string;
  recentTranscript: string;
  note?: string;
  snapshot?: Partial<ParentExecutionContextSnapshot>;
  now: string;
}): HandoffPacket {
  return {
    goal: input.goal.trim(),
    fromSessionKey: input.fromSessionKey,
    originatingClient: input.originatingClient,
    originatingWorkspace: input.originatingWorkspace,
    recentTranscript: input.recentTranscript.slice(0, 4000),
    note: input.note?.trim() || undefined,
    snapshot: input.snapshot,
    createdAt: input.now,
  };
}

export interface HandoffSessionLike {
  sessionKey: string;
  clientKind?: string;
  lastHeartbeatAt?: string;
}

export interface HandoffTargetResolution {
  to?: string;
  error?: string;
}

const NEXT_IDLE_RE = /^([a-z][a-z0-9-]*):next-idle$/i;

function isLikelyFullKey(t: string): boolean {
  return t.length >= 32 || t.includes(":child:");
}

/**
 * Resolve a `/handoff` target into a concrete recipient sessionKey:
 *   - `<clientKind>:next-idle` → the active peer of that kind whose last
 *     heartbeat is OLDEST (most idle), excluding the sender.
 *   - exact sessionKey → itself.
 *   - unique prefix → the match; ambiguous → error.
 *   - otherwise a full-looking key passes through literally.
 */
export function resolveHandoffTarget(
  sessions: HandoffSessionLike[],
  target: string,
  selfSessionKey?: string,
): HandoffTargetResolution {
  const raw = target.trim();
  if (!raw) return { error: "Usage: /handoff <sessionKey | prefix | <clientKind>:next-idle> [note]" };

  const nextIdle = NEXT_IDLE_RE.exec(raw);
  if (nextIdle) {
    const kind = nextIdle[1].toLowerCase();
    const candidates = sessions
      .filter((s) => (s.clientKind ?? "").toLowerCase() === kind && s.sessionKey !== selfSessionKey)
      .sort((a, b) => Date.parse(a.lastHeartbeatAt ?? "0") - Date.parse(b.lastHeartbeatAt ?? "0"));
    if (candidates.length === 0) {
      return { error: `No active "${kind}" peer to hand off to (need one registered + heartbeating).` };
    }
    return { to: candidates[0].sessionKey };
  }

  const keys = sessions.map((s) => s.sessionKey).filter((k) => k && k !== selfSessionKey);
  if (keys.includes(raw)) return { to: raw };
  const matches = keys.filter((k) => k.startsWith(raw));
  if (matches.length === 1) return { to: matches[0] };
  if (matches.length > 1) {
    return {
      error: `Ambiguous target prefix "${raw}" matched ${matches.length} sessions (${matches
        .map((k) => k.slice(0, 12))
        .join(", ")}). Use more characters.`,
    };
  }
  if (isLikelyFullKey(raw)) return { to: raw };
  return { error: `No active session matched "${raw}". Use /agents --remote to see peers, or <clientKind>:next-idle.` };
}
