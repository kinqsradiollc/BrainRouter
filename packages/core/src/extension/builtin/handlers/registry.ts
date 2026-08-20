// ADR-041 D8 — the builtin-tool handler registry: the strangler seam that lets
// the 66-case `switch (name)` in ../runtime.ts dissolve one tool at a time.
//
// A migrated builtin registers a handler here; `invokeBuiltinToolRuntime`
// consults the registry BEFORE the switch, so every un-migrated tool still falls
// through to the switch unchanged. A migrated handler's body is the switch case
// body verbatim (`args` → `ctx.args`, `this.x` → `ctx.host.x`), so the bytes
// returned to the model are identical — that is the byte-neutrality invariant
// every migration slice preserves. When the switch is finally empty, dispatch is
// a registry lookup and D8's shared guarded pipeline fronts every call.

import type { FilesystemPort } from '../../../agent/fs/filesystemPort.js';
import type { ResultCache } from '../../../util/result/resultHandoff.js';
import type { McpClientPool as McpClientWrapper } from '../../../mcp/mcpPool.js';
import type { PlanState } from '../../../task/taskStore.js';
import type { ArtifactRecord } from '@kinqs/brainrouter-types';
import type { LLMConfig } from '../../../config/config.js';
import type { InteractionPort } from '@kinqs/brainrouter-agent-protocol';
import type { InteractivePrompter } from '../../../agent/support/prompter.js';
import type { BrowserFetchPort } from '../../../websearch/inAppBrowser.js';
import type { ComputerUsePort } from '@kinqs/brainrouter-agent-protocol';
import type { SubprocessPort } from '../../../agent/subprocess/subprocessPort.js';
import type { AccessMode } from '../../../orchestration/roles/roles.js';
import type { EffortLevel } from '../../../session/preferences/preferencesStore.js';
import type { WorkspaceScope } from '../../../agent/fs/workspaceFs.js';
import type { ShellPort } from '../../../agent/shell/shellPort.js';
import type { McpConnectorClient } from '../../../connectors/index.js';
import type { CodeRunnerPort } from '../../../exec/codeMode/codeRunnerPort.js';

/**
 * The Agent surface a migrated builtin handler may read. Empty at D8 Phase 1 —
 * the planner tools read nothing off the Agent — and it grows MONOTONICALLY: each
 * migration slice adds only the fields its tool actually uses, cited to the line
 * that reads them. When the switch is gone this interface is the exhaustive,
 * honest list of what builtins need from the Agent, replacing today's `this: any`.
 */
export interface BuiltinToolHost {
  /** Workspace root of the agent's primary scope — runtime.ts:301. (D8 Phase 2: research_brief) */
  readonly workspaceRoot: string;
  /** The agent's session key — runtime.ts. (D8 Phase 2: research_brief) */
  readonly sessionKey: string;
  /** The MCP tools visible to this agent — agent.ts:2505. (D8 Phase 3: mcp_search/describe/refresh_catalog) */
  visibleMcpToolList(): Promise<any[]>;
  /** Resolve a visible MCP tool by name — agent.ts:2555. (D8 Phase 3: mcp_describe) */
  findVisibleMcpTool(target: string): Promise<any | undefined>;
  /** Map an `mcp_<server>_<tool>` name to its server id — agent.ts:2439. (D8 Phase 3: mcp_refresh_catalog) */
  serverIdFromMcpToolName(name: string): string | undefined;
  /** The offloaded-result cache for extract_result — agent.ts:1040. (D8 Phase 7: extract_result) */
  readonly resultCache: ResultCache;
  /** Persist a transcript entry (chapter markers, etc.) — agent.ts:3548. (D8 Phase 10: mark_chapter) */
  recordTranscript(message: any): void;
  /** The last goal transition this turn — MUTABLE; the runTurn guard reads it — agent.ts:3167. (D8 Phase 11: goal_complete/blocked) */
  lastGoalTransition: 'complete' | 'blocked' | undefined;
  /** The active MCP client pool — agent.ts:862. (D8 Phase 12: list/read MCP resources) */
  readonly mcpClient: McpClientWrapper;
  /** The current turn's abort controller (null between turns) — agent.ts:1156. (D8 Phase 12) */
  readonly turnAbort: AbortController | null;
  /** The local pentest proxy admin endpoint/token — agent.ts:1216. (D8 Phase 13: pentest reads) */
  pentestProxyControl(): { apiUrl: string; token?: string } | undefined;
  /** Record an auto-approval into plan history when a new plan version lands — agent.ts:3014. (D8 Phase 14: update_plan) */
  maybeAutoApprovePlan(state: PlanState): void;
  /** Worktrees attached to this agent's scope (read-only view) — agent.ts:939. (D8 Phase 15: worktree_list) */
  readonly attachedRoots: readonly string[];
  /** Persist an artifact into session memory — agent.ts:2389. (D8 Phase 16: artifact_write) */
  captureArtifactToMemory(record: ArtifactRecord): Promise<void>;
  /** Review-mode source-safety gate (redaction + path denial) — agent.ts:1275. (D8 Phase 18: fs reads) */
  readonly reviewSourceSafety: boolean;
  /** Read-before-edit ledger (CC-P6.4); the handler adds to it — agent.ts:1124. (D8 Phase 19: read_file) */
  readonly filesReadThisSession: Set<string>;
  /** Fire-and-forget code reindex on read — agent.ts:3022. (D8 Phase 19: read_file) */
  maybeReindexSource(resolved: string, content: string): Promise<string>;
  /** Returns a cleanup fn (truthy) when running inside reviewed execution — agent.ts:1409. (D8 Phase 21: task_output) */
  inheritedExecutionAuthorityGuard(): (() => void) | undefined;
  /** The live LLM config (switch_model reads model/etc.) — agent.ts:863. (D8 Phase 22: switch_model) */
  readonly llmConfig: LLMConfig;
  /** Overlay a new LLM config for the rest of the session — agent.ts:3030. (D8 Phase 22: switch_model) */
  setLLMConfig(next: Partial<LLMConfig>): void;
  /** Active-session flags the top-level-only gates read — agent.ts:1200/1268/1266. (D8 Phase 25: terminal reads) */
  readonly silent: boolean;
  readonly agentDepth: number;
  readonly tier?: 'chat' | 'reasoning' | 'worker';
  /** The native-terminal (PTY) port; present only in the top-level Desktop session — agent.ts:721. (D8 Phase 25) */
  readonly terminalUsePort?: {
    list(): Array<{ id: string; shell: string; pid: number; start: number; next: number; alive: boolean }>;
    read(id: string, fromOffset: number): { chunk: string; next: number; alive: boolean; dropped: number };
    write(id: string, data: string): boolean;
  };
  /** The UI interaction port (confirm/choice dialogs); absent on headless hosts — agent.ts:688. (D8 Phase 26: terminal_write) */
  readonly interactionPort?: InteractionPort;
  /** The TTY prompter (yes/no + choice); HEADLESS_PROMPTER on non-TTY hosts — agent.ts:1297. (D8 Phase 26: terminal_write) */
  readonly prompter: InteractivePrompter;
  /** True when notification hooks are active (advisory needs-input signal) — agent.ts:3367. (D8 Phase 27: ask_user_choice) */
  hookNotifyActive(): boolean;
  /** This agent's ownership token (null = unowned) — agent.ts:1270. (D8 Phase 28: write_file) */
  readonly ownership: string | null;
  /** Re-assert the inherited execution authority is still current before a write — agent.ts:1404. (D8 Phase 28) */
  assertInheritedExecutionAuthorityCurrent(): void;
  /** Snapshot a file into the /rewind undo log before overwriting it — agent.ts:3018. (D8 Phase 28) */
  captureFileSnapshot(absPath: string): void;
  /** Silent-child write/edit/patch approval gate (returns a denial string, else null) — agent.ts:1507. (D8 Phase 28) */
  confirmSilentChildToolApproval(info: { tool: string; command?: string; path?: string; summary?: string; reason: string; dangerous?: boolean }): Promise<string | null>;
  /** The agent's own MCP client for the `mcp` connector source (undefined if none) — agent.ts:2680. (D8 Phase 34: connector_run) */
  agentMcpConnectorClient(): McpConnectorClient | undefined;
  /** The most recent user prompt — the destructive guard's user-intent input — agent.ts:3135. (D8 Phase 35: worktree_done) */
  readonly lastUserPrompt: string;
  /** SHAs of commits this agent authored — the destructive guard's authorship input — agent.ts:1129. (D8 Phase 35: worktree_done) */
  readonly agentAuthoredCommits: Set<string>;
  /** Attach an existing/created worktree for read+edit (optional; absent on non-Agent hosts) — agent.ts:956. (D8 Phase 35: worktree_enter/create) */
  attachWorktree?(root: string): void;
  /** Attach a foreign-owned worktree READ-ONLY — agent.ts:983. (D8 Phase 35: worktree_enter) */
  attachReadOnlyWorktree?(root: string, owner: string): void;
  /** Detach a removed worktree — agent.ts:970. (D8 Phase 35: worktree_done) */
  detachWorktree?(root: string): void;
  /** True on a pentest turn — host-side egress (fetch_url/web_search) is refused so the scope-pinned sandbox is the only path out — agent.ts:1209. (D8 Phase 36) */
  readonly pentestMode: boolean;
  /** The in-app browser control port (desktop, top-level session); absent on CLI/server — agent.ts:1294. (D8 Phase 36: fetch_url/web_search browser-first) */
  readonly browserControlPort?: BrowserFetchPort;
  /** The desktop computer-control capability (screenshot/act); absent on non-desktop hosts — agent.ts:1288. (D8 Phase 37: computer_use) */
  readonly computerUsePort?: ComputerUsePort;
  /** MUTABLE per-turn computer-action counter the handler increments against the cap — agent.ts:1147. (D8 Phase 37: computer_use) */
  computerActionsThisTurn: number;
  /** MUTABLE per-turn LLM usage tally the pentest dedupe-judge adds to — agent.ts:3058. (D8 Phase 38: file_vulnerability) */
  lastTurnUsage: { promptTokens: number; completionTokens: number; calls: number; cachedTokens: number; missedTokens: number; lastPrefixFingerprint?: string };
  /** Running session usage — the budget denominator — agent.ts:3078. (D8 Phase 38: file_vulnerability) */
  readonly sessionUsage: { promptTokens: number; completionTokens: number; calls: number; turns: number; cachedTokens: number; missedTokens: number };
  /** Per-task budget caps (falls back to cli.budget) — agent.ts:1213. (D8 Phase 38: file_vulnerability) */
  readonly taskBudgetCaps?: { maxPerTaskUSD: number; maxPerTaskTokens: number };
  /** The subprocess capability for spawning workers (default wraps spawnWorkerThread) — agent.ts:1290. (D8 Phase 39: spawn_worker_thread) */
  readonly subprocessPort?: SubprocessPort;
  /** The process launch cwd inherited by a spawned worker — agent.ts:1004. (D8 Phase 39) */
  readonly launchCwd: string;
  /** This agent's access mode, inherited by the child worker — agent.ts:1190. (D8 Phase 39) */
  readonly accessMode: AccessMode;
  /** Reasoning-effort override passed down to the worker — agent.ts:1285. (D8 Phase 39) */
  readonly effortOverride?: EffortLevel;
  /** HONK-H0 — fleet-sandbox lockdown cascaded to descendants — agent.ts:1208. (D8 Phase 39) */
  readonly forceFleetSandbox: boolean;
  /** The federation session key stamped onto outbound MCP identity — agent.ts:906. (D8 Phase 40: mcp_call) */
  readonly federationSessionKey: string | null;
  /** ADR-040 nested-MCP approval gate for a mid-turn tool call (throws to deny) — agent.ts:2460. (D8 Phase 40: mcp_call) */
  approveMcpToolCall(name: string, descriptor: any, args: Record<string, any>): Promise<void>;
  /** The multi-root workspace scope (primary + entered worktrees) for cwd validation — agent.ts:943. (D8 Phase 41: run_command) */
  readonly workspaceScope: WorkspaceScope;
  /** The parent's execution mode a silent child inherits (CHILD-EXEC-INHERIT) — agent.ts:1300. (D8 Phase 41) */
  readonly parentExecutionMode?: 'planning' | 'fast';
  /** Silent-child shell approval gate (returns false to reject) — agent.ts:1286. (D8 Phase 41) */
  confirmToolApproval?: (info: { tool: string; command?: string; path?: string; summary?: string; reason: string; dangerous?: boolean; arguments?: Record<string, unknown> }) => Promise<boolean>;
  /** Enforce the sandbox for silent/unattended agents regardless of the global knob — agent.ts:1207. (D8 Phase 41) */
  readonly sandboxEnforceWhenSilent: boolean;
  /** The shell capability for exec (default wraps runShell/startBackgroundShell) — agent.ts:1291. (D8 Phase 41) */
  readonly shellPort?: ShellPort;
  /** ADR-041 A41-15 — the Code Mode runner (default local subprocess). Optional so
   *  a D10 ExecutionWorld can back it with a container/remote runner; run_code falls
   *  back to the default when unset. */
  readonly codeRunnerPort?: CodeRunnerPort;
  /** The pentest Docker/proxy sandbox descriptor — agent.ts:1210. (D8 Phase 41) */
  readonly pentestSandbox?: { image: string; network: string; proxyUrl: string };
}

/** Everything a migrated handler receives — the shared closures the switch built inline. */
export interface BuiltinToolContext {
  readonly args: Record<string, any>;
  readonly invokedName: string;
  readonly host: BuiltinToolHost;
  /** `resolveWorkspacePathInScope(...)` — runtime.ts:307. */
  readonly resolveHere: (relativeOrAbsolute: string, options?: { forWrite?: boolean }) => string;
  /** Rejects a path outside the read-allowed scope — runtime.ts:318. */
  readonly readOnlyGuard: (path: string) => void;
  /** The D3 filesystem capability (default `nodeFilesystemPort`) — runtime.ts:327. */
  readonly fsPort: FilesystemPort;
  /** Present only for nested-MCP tools that authorize a target mid-call. */
  readonly authorizeMcpTarget?: (name: string, args: Record<string, unknown>, descriptor: unknown) => void;
  /**
   * ADR-041 A41-15 — Code Mode's sub-dispatch: run_code hands each
   * `agent.<tool>(args)` from the program to this closure, which re-gates it
   * through the FULL D8 pipeline (authorize + parent-token assert) and returns the
   * tool result. Present only for trusted first-party builtins (it flows through
   * the same trusted `builtinRuntime.invoke` path as `authorizeMcpTarget`, so a
   * user-extension tool can never receive it — CWE-266).
   */
  readonly codeModeDispatch?: (tool: string, args: Record<string, unknown>) => Promise<string>;
}

export type BuiltinToolHandler = (ctx: BuiltinToolContext) => Promise<string>;

const HANDLERS = new Map<string, BuiltinToolHandler>();

/** Register a migrated builtin's handler. Throws on a duplicate name — a tool has one home. */
export function registerBuiltinHandler(name: string, handler: BuiltinToolHandler): void {
  if (HANDLERS.has(name)) {
    throw new Error(`Duplicate builtin tool handler registration: ${name}`);
  }
  HANDLERS.set(name, handler);
}

/** The handler for `name`, or undefined if the tool still lives in the switch. */
export function builtinToolHandler(name: string): BuiltinToolHandler | undefined {
  return HANDLERS.get(name);
}

/** The set of tool names that have been migrated to a registered handler. */
export function registeredHandlerNames(): ReadonlySet<string> {
  return new Set(HANDLERS.keys());
}
