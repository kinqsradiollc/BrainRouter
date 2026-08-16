// 0.3.7 — Multi-MCP support. The orchestrator forwards the parent's
// pool to spawned children so a child can call tools across every
// configured MCP server, not just the one the parent happened to be
// connected to. The Pool's facade matches the single-Wrapper API so
// this is a near-no-op type swap.
import type { McpClientPool as McpClientWrapper } from '../../mcp/mcpPool.js';
import type { LLMConfig } from '../../config/config.js';
import type { AccessMode } from '../roles/roles.js';
import type { Tier } from '../agents/agentRegistry.js';
import type { ContextEnvelope } from '../../context/contextEnvelope.js';
import type {
  PreparedProfileStageDelegation,
  ProfileStageDelegationOutput,
} from '../runtime/profileStageController.js';
import type { ChildExecutionReceipt } from '@kinqs/brainrouter-agent-protocol';
import type { ExecutionIntentRecord } from '@kinqs/brainrouter-types/agent';
import type { ReviewedExecutionPolicySnapshot } from '../execution/policySnapshot.js';

export interface ProfileStageRuntimeController {
  invoke(args: Record<string, unknown>): Promise<string>;
  prepareDelegation(input: {
    stageId: string;
    requestedRoleId?: string;
    assignment?: string;
  }): Promise<PreparedProfileStageDelegation>;
  ownsPreparedDelegation(value: unknown): value is PreparedProfileStageDelegation;
  inspectDelegationOutput(
    launch: PreparedProfileStageDelegation,
    output: string,
  ): ProfileStageDelegationOutput;
  finishDelegation(launch: PreparedProfileStageDelegation, accepted: boolean): void;
  rejectDelegation(launch: PreparedProfileStageDelegation): void;
}

export interface OrchestrationContext {
  workspaceRoot: string;
  parentSessionKey: string;
  /** Stable owner of this orchestration call within the current Agent turn. */
  turnExecutionId?: string;
  /**
   * Present only after the live Agent consumed an opaque explicit-launch
   * capability. Serializable metadata is audit context, never proof by itself.
   */
  executionLaunch?: {
    runId: string;
    parentExecutionId: string;
    record: ExecutionIntentRecord;
    /** Process-local executor authority; never serialize this context field. */
    dispatchReceipt: unknown;
    /** Agent-owned live policy fence installed only after receipt consumption. */
    assertAuthorityCurrent?: () => void;
  };
  /**
   * Process-local live lease inherited by descendants of a reviewed durable
   * execution. Unlike `executionLaunch`, this carries no one-shot dispatch
   * receipt or serializable audit metadata; it only lets nested agents fail
   * closed after the owning user, workspace, session, or policy is revoked.
   */
  executionAuthorityGuard?: () => void;
  /** Exact parent instruction snapshot bound to the reviewed execution. */
  executionInstructionSummary?: string | null;
  /** Content-free hash of the exact MCP catalog reviewed for this execution. */
  executionMcpInventoryFingerprint?: string;
  /** Parent checkout that owns reviewed manifest, role, hook, and preference policy. */
  executionPolicyWorkspaceRoot?: string;
  /** Immutable manifest, role, hook, and delegation policy captured at review. */
  executionPolicySnapshot?: ReviewedExecutionPolicySnapshot;
  /**
   * Parent agent's access mode. Child agents may not exceed this — a `read`
   * parent cannot spawn a `shell` child, even if the LLM passes `access:'shell'`
   * to spawn_agent. Without this clamp, `spawn_agent` was a privilege-escalation
   * primitive: a read-mode parent could request a shell-mode child and the
   * child would silently run with elevated permissions.
   */
  parentAccessMode?: AccessMode;
  /**
   * HONK-H0 — true when the spawning agent is itself a fleet executor (or has a
   * fleet ancestor). The locked-down sandbox + secret-scoping posture cascades to
   * EVERY descendant, so a fleet child can't escape it by spawning a plain worker.
   */
  ancestorFleet?: boolean;
  /**
   * Parent OTEL trace context. When set, child agents nest their per-turn
   * spans under the dispatching `spawn_agent` tool span instead of starting
   * a fresh trace. Lets observability viewers reconstruct fan-out trees.
   */
  parentTraceId?: string;
  parentSpanId?: string;
  /** Parent agent_id so children can be grouped via attribute even without trace links. */
  parentAgentId?: string;
  /** Parent agent tier — used for hierarchy checks (worker cannot spawn; reasoning can only spawn workers). */
  parentTier?: Tier;
  /** Current spawn-chain depth (0 = direct child of chat root). */
  depth?: number;
  /** The parent turn's interrupt signal. A Stop unblocks waits and the parent
   *  cascades interruption to every child it owns. */
  interruptSignal?: AbortSignal;
  mcpClient: McpClientWrapper;
  llmConfig: LLMConfig;
  launchCwd: string;
  /** Called when a child output got offloaded — chars beyond preview that didn't land in parent context. */
  recordOffload?: (charsAvoided: number) => void;
  /** FOOTER-TELEMETRY-2 — called when a child completes, with its total token
   *  spend (prompt + completion), so the parent can surface cumulative child
   *  cost in the footer `offload` segment without a per-render disk scan. */
  recordChildTokens?: (tokens: number) => void;
  /**
   * Paired child tool lifecycle callbacks. Fire from the child agent's
   * onToolStart / onToolEnd so the parent's REPL can render explicit
   * "child began X" / "child finished X" rows in the scrollback — without
   * these, long child runs look like the parent has frozen (roadmap §3).
   */
  onChildToolStart?: (event: { childId: string; role: string; tool: string; args: Record<string, any> }) => void;
  onChildToolEnd?: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }) => void;
  /**
   * Called when a child agent's runTurn ends — success, fail, or empty answer.
   * Lets the REPL surface "✓ agent X completed" so the user knows when to act,
   * instead of seeing tool events and then silence.
   */
  onChildComplete?: (receipt: ChildExecutionReceipt) => void;
  /**
   * MAS-P4-T2 supervisor gate. When the delegation policy needs approval,
   * `handleSpawn` calls this to ask the user (returns true to allow).
   * Wired only for an interactive parent; absent in headless runs, where
   * an `ask-*` policy fails closed. May throw a clear error when no
   * terminal is attached.
   */
  confirmDelegation?: (info: { role: string; access: AccessMode; prompt: string }) => Promise<boolean>;
  /**
   * CODEX-PARENT-APPROVAL — child agents run silently, so risky tool prompts
   * are routed back through the parent/UI instead of being denied solely because
   * the child cannot read from the terminal.
   */
  confirmToolApproval?: (info: {
    childId: string;
    role: string;
    tool: string;
    command?: string;
    path?: string;
    summary?: string;
    reason: string;
    dangerous?: boolean;
  }) => Promise<boolean>;
  // MAS-P2-M3 parent-context accessors. Each returns the parent's
  // runtime state at spawn time — all optional so callers can adopt
  // incrementally. When omitted, the snapshot field stays undefined
  // rather than guessing.
  parentBriefingBlock?: () => string | null | undefined;
  parentRecalledRecordIds?: () => string[];
  parentGoal?: () => { text: string; status: string } | null | undefined;
  parentPlanText?: () => string | null | undefined;
  parentContextEnvelope?: () => ContextEnvelope;
  parentSourceFiles?: () => string[];
  parentVisibleTools?: () => string[];
  parentVisibleLocalTools?: () => string[];
  parentVisibleMcpTools?: () => string[];
  parentExecutionMode?: string;
  parentReviewPolicy?: string;
  /**
   * Root-turn owner for the currently resolved profile plan. Missing for
   * children, unmanaged workspaces, and turns whose plan has no profile.
   */
  profileStageController?: ProfileStageRuntimeController;
}
