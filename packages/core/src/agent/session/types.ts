/**
 * ADR-050 P1 — the ONE session seam every external-agent seat drives (the main
 * loop's engine, a delegated worker, a worktree runtime).
 *
 * A persistent per-agent session with a canonical lifecycle: `open` (spawn or
 * attach) → `prompt` (one INCREMENTAL user turn) → normalized events →
 * `interrupt` → `close`, plus an opaque `resumeCursor` the caller persists and
 * replays on reopen.
 *
 * The event union is deliberately small here: `text` + `done`. The richer
 * variants (tool activity, plan updates, permission requests) arrive with the
 * structured transports (P2/P3) that actually emit them, normalized into the
 * `agent-protocol` vocabulary the hosts already render — a union that grows, not
 * a shape that changes.
 */
import type { spawn } from 'node:child_process';

/**
 * The wire a session speaks. `stdio-oneshot` wraps the pre-ADR-050 one-shot spawn
 * (byte-identical behaviour); the others are the structured protocols added in P2.
 */
export type AgentSessionTransport =
  | 'stdio-oneshot'
  | 'claude-stream-json'
  | 'codex-app-server'
  | 'acp-stdio';

/** Why a turn ended. */
export type SessionStopReason = 'stop' | 'interrupted' | 'error';

/** A normalized event from a live external-agent session. */
export type AgentSessionEvent =
  /** Assistant output text (a delta, or a whole block for non-streaming transports). */
  | { kind: 'text'; delta: string }
  /** Read-only narration of the agent running its OWN tool (we render, we don't proxy). */
  | { kind: 'tool'; phase: 'start' | 'end'; name: string; detail?: string }
  /** The transport captured/updated its resumable session id (P4 persists it). */
  | { kind: 'session'; sessionId: string }
  /** The turn ended. */
  | { kind: 'done'; reason: SessionStopReason; error?: string };

/** How to spawn (or reopen) a session. */
export interface AgentSessionSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Reopen an earlier session (opaque, transport-specific). */
  resumeCursor?: string;
}

/** Per-turn callbacks. */
export interface AgentSessionHandlers {
  onEvent: (event: AgentSessionEvent) => void;
  signal?: AbortSignal;
}

/** The result of one prompt turn. */
export interface AgentSessionTurn {
  text: string;
  reason: SessionStopReason;
}

/** A persistent external-agent session. */
export interface AgentSessionPort {
  readonly transport: AgentSessionTransport;
  /** Opaque resume cursor captured this session, or undefined. The caller persists it. */
  readonly resumeCursor: string | undefined;
  /** Spawn or attach. Idempotent while open. */
  open(): Promise<void>;
  /** One incremental user turn: emit events via handlers, resolve with the final text + reason. */
  prompt(text: string, handlers: AgentSessionHandlers): Promise<AgentSessionTurn>;
  /** Cancel the in-flight turn via the protocol (caller may escalate to close()). */
  interrupt(): Promise<void>;
  /** Terminate the session. */
  close(): Promise<void>;
}

/** Injected dependencies (tests pass a fake spawn). */
export interface AgentSessionDeps {
  spawnImpl?: typeof spawn;
}
