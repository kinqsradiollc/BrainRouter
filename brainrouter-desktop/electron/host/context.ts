/**
 * host/context — the shared runtime bag `main()` assembles and hands to the
 * extracted query/service modules.
 *
 * host.ts is an Electron utilityProcess entrypoint: its ~2400-line query router
 * used to be a single object literal of closures over `main()`-local state. To
 * break it into cohesive sibling modules WITHOUT changing behavior, that state
 * is bundled here once and passed to each module's factory. The factories
 * destructure exactly the bindings they use, so the handler bodies stay
 * byte-identical to the original.
 *
 * Nothing here is new logic — every field is one of the `const`/`let` bindings
 * `main()` already created. The types mirror those declarations so `tsc`
 * validates both the producer (the `ctx` literal in host.ts) and every consumer.
 */
import type { AgentEvent, RecordLifecycleAction } from '@kinqs/brainrouter-agent-protocol';
import type { Agent } from '@kinqs/brainrouter-core/agent';
import type { LLMConfig } from '@kinqs/brainrouter-core/config';
import type { McpClientPool } from '@kinqs/brainrouter-core/mcp';
import type { AgentLike } from '../hostCore.js';
import type { resolveWorkspaceGit } from '@kinqs/brainrouter-core/git';
import type { WorkspaceFileListCache, WorkspaceFileListResult } from '../workspaceFileListCache.js';
import type { reviewGate, ReviewRun, Severity } from '@kinqs/brainrouter-core/review';
import type { PlanDecision } from '@kinqs/brainrouter-core/task';
import type { BackgroundTaskRecord } from '@kinqs/brainrouter-types';
import type { RequirementRecord } from '@kinqs/brainrouter-types';
import type { AnnotationRecord } from '@kinqs/brainrouter-types';
import type { ArtifactRecord } from '@kinqs/brainrouter-types';
import type { GithubConnectorClient, GithubConnectorPermissionClient, GithubConnectorValidationClient, McpConnectorClient } from '@kinqs/brainrouter-core/connectors';
import type { ComputerUseBridge, SecretBridge, TermSession } from './helpers.js';
import type { UiTestHost } from '../uitestHost.js';

type WsGit = ReturnType<typeof resolveWorkspaceGit>;

/** The renderer's short-lived transcript-read cache row shape (host-private). */
export type TxEntry = { role?: string; content?: unknown; name?: string; tool_calls?: unknown[]; tool_call_id?: string; isError?: boolean; timestamp?: string };

export type TrackPrView = {
  number?: number; state?: string; title?: string; url?: string;
  headRefName?: string; baseRefName?: string; isDraft?: boolean;
  mergeable?: string; statusCheckRollup?: unknown[];
};

export type GhResult = { ok: boolean; stdout: string; stderr: string; error?: string };

/**
 * The bag of `main()`-local state the extracted modules close over. Assembled
 * once in host.ts (`const ctx: HostContext = { … }`) after everything below has
 * been created, then passed to the query/service factories.
 */
export interface HostContext {
  // ── Core runtime ──────────────────────────────────────────────────────────
  // UI-TEST fusion — the web UI-testing host the query router drives.
  uitest: UiTestHost;
  workspaceRoot: string;
  wsGit: WsGit;
  fileListCache: WorkspaceFileListCache;
  listWorkspaceFilesCached: (args: Record<string, unknown>) => Promise<WorkspaceFileListResult>;
  send: (msg: unknown) => void;
  computerUseBridge: ComputerUseBridge | undefined;
  secretBridge: SecretBridge | undefined;
  config: ReturnType<typeof import('@kinqs/brainrouter-core/config').loadConfig>;
  // `llm` is a `let` in main() (reassigned when the global default changes), so
  // reads go through a live getter and writes through a setter rather than a
  // captured value — the same live binding the rest of main() closes over.
  getLlm: () => LLMConfig;
  setLlm: (next: LLMConfig) => void;
  mcpClient: McpClientPool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callBrainAtlas: (tool: string, args: Record<string, unknown>) => Promise<any | null>;
  broker: import('@kinqs/brainrouter-agent-protocol').InteractionBroker;
  emitPortFor: (sessionKey: string, e: { kind: 'interaction-request'; request: import('@kinqs/brainrouter-agent-protocol').InteractionRequest }) => void;
  agent: AgentLike;
  // `activeAgent` is reassigned by hostCore's onActiveAgentChange, so reads go
  // through a live getter to always see the session the user is viewing. It
  // returns the concrete Agent (not the structural AgentLike) so the handlers
  // that call the full agent surface (compactHistory/getPrefixStability/…) keep
  // typechecking exactly as they did against the `typeof agent` local.
  getActiveAgent: () => Agent;
  loadGlobalLlm: () => LLMConfig;
  llmForSession: (sessionKey: string) => LLMConfig;
  resolveProviderLlm: (providerName: string, model: string) => LLMConfig | undefined;
  syncActiveSessionLlm: (base?: LLMConfig) => LLMConfig;
  spawnAgent: (sessionKey: string) => AgentLike;
  spawnReviewer: (sessionKey?: string) => AgentLike;
  spawnTaskAgent: (sessionKey: string, access: 'read' | 'write') => AgentLike;
  activeMemorySessionKey: () => string;
  lifecycleActionFor: (change: string) => RecordLifecycleAction;
  emitRecordEvent: (event: AgentEvent) => void;

  // ── Task + verification bookkeeping ─────────────────────────────────────────
  taskEventView: (t: BackgroundTaskRecord) => import('@kinqs/brainrouter-agent-protocol').BackgroundTaskEventView;
  emitTaskEvent: (action: 'created' | 'progress' | 'updated' | 'completed' | 'failed' | 'canceled', t: BackgroundTaskRecord) => void;
  taskProgress: (id: string, phase: string, note?: string) => void;
  verifyTitle: (command: string) => string;
  observeVerificationEvent: (sessionKey: string, event: AgentEvent) => void;
  goalStrikes: Map<string, number>;

  // ── Memory-provenance capture ───────────────────────────────────────────────
  captureRequirementNote: (record: RequirementRecord, change: string) => Promise<void>;
  captureAnnotationNote: (record: AnnotationRecord, change: string) => Promise<void>;
  captureAnnotationExportNote: (records: AnnotationRecord[]) => Promise<void>;
  captureArtifactNote: (record: ArtifactRecord, change: string) => Promise<void>;

  // ── Terminals + short-lived caches ──────────────────────────────────────────
  terms: Map<string, TermSession>;
  nextTermSeq: () => number;
  modelsCacheByKey: Map<string, { models: string[]; at: number }>;
  getPrCache: () => { at: number; pr: { number: number; state: string; title?: string } | null } | null;
  setPrCache: (v: { at: number; pr: { number: number; state: string; title?: string } | null } | null) => void;
  getPrStatusMapCache: () => { at: number; prs: unknown[] } | null;
  setPrStatusMapCache: (v: { at: number; prs: unknown[] } | null) => void;
  readTranscriptCached: (key: string) => TxEntry[];

  // ── Review v2 ──────────────────────────────────────────────────────────────
  isoNow: () => string;
  collectWorkingDiff: () => Promise<{ diff: string; files: string[] }>;
  runReview: (ctx?: { reviewerKey?: string; onPhase?: (phase: string, note?: string) => void }) => Promise<ReviewRun & { files: number }>;
  runReviewTask: (sessionKey: string) => Promise<ReviewRun & { files: number; taskId: string }>;
  reviewSnapshot: () => Promise<{ run: ReviewRun | null; gate: ReturnType<typeof reviewGate>; diffHash: string; files: number }>;
  runPlanRevisionTask: (sessionKey: string, decision: PlanDecision, feedback: string) => BackgroundTaskRecord;

  // ── GitHub / gh CLI ─────────────────────────────────────────────────────────
  // Reset the cached gh CLI env (host-local `let ghEnvCache`) when a config save
  // changes the CA bundle, so the next gh call re-derives it.
  resetGhEnvCache: () => void;
  ghText: (args: string[], opts?: { timeout?: number; maxBuffer?: number }) => Promise<GhResult>;
  ghJson: <T>(args: string[], opts?: { timeout?: number; maxBuffer?: number; allowNonZeroJson?: boolean }) => Promise<{ data?: T; error?: string }>;
  githubApiBase: (connector: { config?: Record<string, unknown> }) => string;
  githubStaticToken: (connector: { credential?: { mode?: string; ref?: string } }) => { token?: string; error?: string };
  githubConnectorToken: (connector: { id: string; credential?: { mode?: string; ref?: string } }) => Promise<{ token?: string; error?: string }>;
  connectorEnvToken: (connector: { credential?: { mode?: string; ref?: string } }, label: string) => { token?: string; error?: string };
  mcpConnectorClient: () => McpConnectorClient;
  githubTokenJson: <T>(connector: { config?: Record<string, unknown> }, token: string, apiPath: string) => Promise<T>;
  currentGitBranch: () => Promise<string | null>;
  trackItemForBranch: (branch: string) => { id: string; key: string } | undefined;
  readTrackPrStatus: () => Promise<{ pr: TrackPrView | null; branch: string | null; itemKey?: string; error?: string }>;
  githubGhValidationClient: () => GithubConnectorValidationClient;
  githubTokenValidationClient: (connector: { config?: Record<string, unknown> }, token: string) => GithubConnectorValidationClient;
  githubGhPermissionClient: () => GithubConnectorPermissionClient;
  githubTokenPermissionClient: (connector: { config?: Record<string, unknown> }, token: string) => GithubConnectorPermissionClient;
  validateGithubConnector: (connectorId: string) => Promise<{ ok: boolean; checked: string[]; errors: string[]; connector: unknown | null }>;
  githubConnectorClient: () => GithubConnectorClient;

  // ── Connectors (checkpoint + permission runners) ────────────────────────────
  indexConnectorMemory: (connectorId: string) => Promise<{ ok: boolean; records: number; evidence: number; operations: number; result?: unknown; error?: string }>;
  runConnector: (connectorId: string) => Promise<{ ok: boolean; run?: unknown; connector?: unknown | null; documents?: unknown[]; memory?: unknown; errors?: string[]; error?: string }>;
  syncConnectorPermissions: (connectorId: string) => Promise<{ ok: boolean; run?: unknown; connector?: unknown | null; permissions?: unknown[]; errors?: string[]; error?: string }>;

  // ── Track ⇄ GitHub PR workflow ──────────────────────────────────────────────
  createTrackDraftPr: (idOrKey: string) => Promise<{ ok: boolean; url?: string; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; items: unknown[]; error?: string }>;
  importTrackIssuesFromGh: (args: Record<string, unknown>) => Promise<{ direction: 'import'; dryRun: boolean; imported: Array<{ issueNumber: number; title: string; action: 'create' | 'update'; key?: string }>; errors: string[]; items: unknown[] }>;
  mergeCurrentTrackPr: () => Promise<{ ok: boolean; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; items: unknown[]; error?: string }>;
  submitTrackPrReview: (args: Record<string, unknown>) => Promise<{ ok: boolean; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; error?: string }>;
  fixCurrentTrackPrChecks: () => Promise<{ ok: boolean; task?: BackgroundTaskRecord; pr?: TrackPrView | null; branch?: string | null; itemKey?: string; error?: string }>;

  // ── Severity map (review) ───────────────────────────────────────────────────
  SEV_MAP: Record<string, Severity>;
}
