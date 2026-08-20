/**
 * DESK-1 — the agent host process (Electron utilityProcess).
 *
 * THE SETTINGS-REUSE CONTRACT LIVES HERE: this bootstrap deep-imports the
 * unchanged brainrouter-cli runtime and boots it exactly like `brainrouter
 * chat` does — `loadConfig()` reads the SAME `~/.config/brainrouter/
 * config.json` (profiles, cli.* knobs, permissions, hooks), the MCP pool
 * connects the SAME server profiles, and all workspace state
 * (.brainrouter/cli/ sessions, workers, plans, goals) is shared with the CLI.
 * Sign in once, configure once — both heads see it.
 */
import { createBrokerPort, createHostCore, type AgentLike } from './hostCore.js';
import { mergeGithubCliEnv, normalizeGithubCliError } from './ghCli.js';
// host/helpers — pure, closure-free helpers (config scrubbing, Track↔GitHub
// normalization, computer-use/secret bridges, endpoint model probing, transcript
// row reconstruction) extracted verbatim from this file.
import { createComputerUseBridge, createSecretBridge, git, type ParentPortLike } from './host/helpers.js';
// host/queries — the extracted query router (the former inline ~2400-line
// `queries` object). host.ts assembles the HostContext bag below and folds
// buildQueries(ctx) into createHostCore({ queries }).
import { buildQueries } from './host/queries.js';
import { createAuthenticatedHumanCorrectionIngress } from './host/humanCorrectionIngress.js';
import {
  initialDesktopLearningBinding,
  isBrainRouterLearningProfile,
  resolveDesktopLearningBinding,
  type DesktopLearningIdentityConfig,
} from './host/learningIdentity.js';
import { PtyRegistry } from './host/pty.js';
import { HostedAgentManager } from './host/hostedAgents.js';
import { FanoutManager } from './host/fanoutManager.js';
import { RemoteWorktreeManager } from './host/sshRemote.js';
import { MobileRelayServer } from './host/mobileRelayServer.js';
import { createRemoteAccessClient } from './host/remoteAccessWiring.js';
import { createEgressTunnelClient, egressTunnelEnabled } from './host/egressTunnelWiring.js';
import { endBrainSession, ensureBrainSession, getBrainSessionKey } from './host/brainSession.js';
import { requestDesktopHeldConfirmation } from './host/heldMessageConfirmation.js';
import { DesktopSessionMessaging } from './host/sessionMessaging.js';
import {
  fetchAccountModelCatalog,
  emptyAccountModelCatalog,
  resolveBrainRouterAccountApi,
  resolveBrainRouterAccountBaseUrl,
  withAccountOrgId,
  type BrainRouterAccountContext,
  type DesktopAccountModelCatalog,
} from './accountIntegration.js';
// host/github-track-services — the extracted gh-CLI / connector / Track-PR
// service layer. host.ts builds it with its runtime deps and folds the returned
// functions into the HostContext.
import { buildGithubTrackServices } from './host/github-track-services.js';
import type { HostContext } from './host/context.js';
// BROWSER — the web browser-automation host (extract, drive, flows/stories, run
// reports, auto-host). Wired into the query router via HostContext.browser.
import { createBrowserHost } from './browserHost.js';
// Dev-server registry — starts/stops launch.json dev servers for the Servers panel
// and the browser host's story auto-host. Extracted from the browser host.
import { createDevServerRegistry } from './devServerRegistry.js';
import { exec, execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { InteractionBroker, type AgentEvent, type RecordLifecycleAction } from '@kinqs/brainrouter-agent-protocol';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { Agent, classifyForVerification } from '@kinqs/brainrouter-core/agent';
import { createBrowserControlBridge, type BrowserControlPort } from '@kinqs/brainrouter-core/browser';
import { loadConfig, saveConfig, _resetCliKnobsCache, type LLMConfig } from '@kinqs/brainrouter-core/config';
// 0.4.15 — named providers + per-sub-agent model routing (pure transforms).
import {
  setProvider,
  removeProvider,
  setAgentModel,
  normalizeProviderModels,
  PROVIDER_CATALOG,
  LOCAL_PLACEHOLDER_KEY,
  withApiVersion,
  inferModelReasoningCapabilities,
  registerModelReasoningCapabilities,
  refreshLmStudioCache,
} from '@kinqs/brainrouter-core/provider';
import { McpClientPool, selectMcpServerIds } from '@kinqs/brainrouter-core/mcp';
import {
  loadTranscript,
  transcriptExists,
  appendTranscriptEntry,
  getSessionRuntime,
  setSessionRuntime,
  resolveSessionLlmConfig,
  resolveActiveMode,
  getSessionMode,
  normalizeEffort,
  readPreferences,
} from '@kinqs/brainrouter-core/session';
import { readUsageHistory, totalUsage } from '@kinqs/brainrouter-core/usage';
import { resolveWorkspaceGit } from '@kinqs/brainrouter-core/git';
import { listWorkspaceFiles } from './fsRead.js';
import { saveWorkflowGraph, loadWorkflowGraph, listWorkflowGraphs, deleteWorkflowGraph } from '@kinqs/brainrouter-core/workflow';
import type { WorkflowGraph } from '@kinqs/brainrouter-core/workflow';
import { writeThreadKey, buildGroundingBlock, pickLocalGrounding } from '@kinqs/brainrouter-core/write';
import { WorkspaceFileListCache, type WorkspaceFileListResult } from './workspaceFileListCache.js';
import { startWorkspaceWatcher } from './fileWatch.js';
import { loadSchedules, addSchedule, removeSchedule, setScheduleEnabled } from '@kinqs/brainrouter-core/schedule';
import { parseCron, nextCronFire } from '@kinqs/brainrouter-core/schedule';
import {
  buildReviewInstructionBlockForDiff,
  readBoundedReviewSourceText,
  runLocalReviewOrchestration,
  UNTRUSTED_REVIEW_EVIDENCE_RULE,
  type LocalReviewOrchestrationResult,
} from '@kinqs/brainrouter-core/review';
import {
  hashDiff,
  reviewGate,
  staleIfDiffChanged,
  type ReviewRun,
  type ReviewFinding,
  type Severity,
} from '@kinqs/brainrouter-core/review';
import { getLatestReview, saveReview } from '@kinqs/brainrouter-core/review';
import { recordHumanCorrection } from '@kinqs/brainrouter-core/learning';
// DESK-4c — the command/settings surfaces reuse the CLI's own modules so the
// desktop never drifts from the terminal: same catalog, same preferences
// file, same hooks store, same transcript tooling.
import { SLASH_COMMANDS, HELP_CATEGORIES } from '@kinqs/brainrouter-core/command';
import { readHooks, setHookEnabled } from '@kinqs/brainrouter-core/hooks';
// DESK-5 — the command bridge dispatches REPL-only commands against the SAME
// stores the terminal CLI uses. No parallel state: /goal here is /goal there.
import {
  readGoal,
  setGoal,
  clearGoal,
  pauseGoal,
  resumeGoal,
  editGoal,
  decideGoalContinuation,
  buildGoalContinuationPrompt,
  goalCorrectiveNotice,
  tickGoalIteration,
  usageLimitGoal,
  formatBudget,
  buildGoalKickoffPrompt,
} from '@kinqs/brainrouter-core/goal';
// §goal-autonomy — the kickoff prompt builder (shared with the CLI's /goal).
import { loadExtensions } from '@kinqs/brainrouter-core/extension';
import { isExtensionEnabled, setExtensionEnabled } from '@kinqs/brainrouter-core/extension';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace } from '@kinqs/brainrouter-core/workspace';
import { readPlan, formatPlan, updatePlan } from '@kinqs/brainrouter-core/task';
// DURABLE BACKGROUND TASKS (0.4.15 workflow gaps) — plan-revision + review work
// runs as visible, file-backed tasks (shared with the CLI store) so progress +
// transcript survive workspace/session switches and host reload.
import {
  createBackgroundTask,
  updateBackgroundTask,
  appendTaskProgress,
  linkBackgroundTaskMemory,
  currentPhase,
  reconcileBackgroundTasks,
} from '@kinqs/brainrouter-core/background';
import { pidAlive } from '@kinqs/brainrouter-core/background';
import type { BackgroundTaskRecord } from '@kinqs/brainrouter-types';
import type { BackgroundTaskEventView } from '@kinqs/brainrouter-agent-protocol';
// ATTACHMENTS (0.4.15 workflow gaps) — ingest files (drag/drop + picker) into
// durable attachment records, shared with the CLI `/attach` store.
import { ingestAttachment, attachmentContextMarkdown } from '@kinqs/brainrouter-core/attachment';
import { listAttachments, getAttachment, linkAttachmentMemory } from '@kinqs/brainrouter-core/attachment';
// TELEMETRY (0.4.15 workflow gaps) — local-first task/review/upload lifecycle.
import { recordTelemetry } from '@kinqs/brainrouter-core/telemetry';
import { TELEMETRY_EVENTS } from '@kinqs/brainrouter-core/telemetry';
// §7 PLAN REVIEW — durable plan approval + version history (per-session decision
// log that snapshots the plan). Shared with the CLI's /plan approve·request-changes·
// history; the desktop panel reads/records through these thin wrappers — no
// parallel store. A best-effort memory note is captured + linked, mirroring the CLI.
import { recordPlanDecision, linkPlanDecision, type PlanDecision } from '@kinqs/brainrouter-core/task';
import { emitAgentEvent, emitArtifactCapture, emitAnnotationCapture } from '@kinqs/brainrouter-core/memory';
// REQUIREMENT-RECORDS — Requirement Records store (shared with the CLI).
import { linkRequirement } from '@kinqs/brainrouter-core/requirement';
import {
  buildBaseGraph,
  saveAtlasGraph,
  readAtlasGraph,
  atlasGraphStats,
  atlasWorkspaceTag,
  enrichAtlasGraph,
  carryForwardSummaries,
  buildAtlasChangeContext,
  extractAtlasJson,
  type AtlasLlmCaller,
} from '@kinqs/brainrouter-core/atlas';
import {
  ensureProject,
  getProject,
  getWorkItem,
  listWorkItems,
  createWorkItem,
  transitionWorkItem,
  updateWorkItem,
  addComment,
  linkWorkItem,
  createSprint,
  listSprints,
  setSprintState,
  createModule,
  listModules,
  updateModule,
  deleteModule,
  saveView,
  listViews,
  deleteView,
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  getGithubLinks,
  setGithubLink,
  type CreateWorkItemInput,
  type UpdateWorkItemPatch,
  type UpdateModulePatch,
  type AutomationPatch,
} from '@kinqs/brainrouter-core/track';
import {
  exportToGithub,
  importFromGithub,
  syncBidirectional,
  importMembersFromGithub,
  resolveGithubConfigForWorkspace,
  listResolvedGithubConfigsForWorkspace,
  issueToWorkItem,
  migrateTrackGithubToConnector,
  setGithubSyncTarget,
  type GithubIssue,
} from '@kinqs/brainrouter-core/track';
import { readGitTrackContext, startGitWorkForTrackItem } from '@kinqs/brainrouter-core/track';
import {
  createConnector,
  deleteConnector,
  finishConnectorRun,
  getConnector,
  listConnectorRuns,
  listConnectors,
  recordConnectorRun,
  updateConnector,
} from '@kinqs/brainrouter-core/connectors';
import { exportConnectorDefinitions, importConnectorDefinitions } from '@kinqs/brainrouter-core/connectors';
import {
  // Per-source checkpoint runtimes + token/client factories now live behind
  // core's shared `buildCheckpointRunner` (the host's switch delegates to it).
  buildCheckpointRunner,
  runGithubConnectorPermissionSync,
  validateGithubConnectorAccess,
  type GithubConnectorClient,
  type GithubConnectorPermissionClient,
  type GithubConnectorValidationClient,
  type McpConnectorClient,
  type McpConnectorResource,
} from '@kinqs/brainrouter-core/connectors';
import { countConnectorDocuments, searchConnectorDocuments, upsertConnectorDocuments } from '@kinqs/brainrouter-core/connectors';
import { countConnectorPermissions, listConnectorPermissions, upsertConnectorPermissions } from '@kinqs/brainrouter-core/connectors';
import type { WorkItemType, SprintState, CodeLink, AutomationTrigger, AutomationAction, ProjectRole, ConnectorFlow, ConnectorRecord, ConnectorSource } from '@kinqs/brainrouter-types';

import { type RequirementRecord } from '@kinqs/brainrouter-types';
// ANNOTATION-RECORDS (0.4.15) — durable feedback records store + markdown
// export (shared with the CLI). Thin wrappers below keep all business logic in
// the CLI store; the desktop panel only reads/mutates through these endpoints.
import { linkAnnotation } from '@kinqs/brainrouter-core/annotation';
import { annotationsToMarkdown } from '@kinqs/brainrouter-core/annotation';
import { listAnnotations, setStatus as setAnnotationStatus } from '@kinqs/brainrouter-core/annotation';
import { type AnnotationRecord } from '@kinqs/brainrouter-types';
// ARTIFACT-RECORDS (0.4.15) — durable Artifact Records store (shared with the
// CLI). Thin wrappers below keep all business logic in the CLI store; the
// desktop panel only reads/mutates/previews through these endpoints.
import { linkArtifact, createArtifact, updateArtifact, readArtifactsAll } from '@kinqs/brainrouter-core/artifact';
import { type ArtifactRecord } from '@kinqs/brainrouter-types';
import { listWorkers, readWorkerSummary, readWorkerTranscript, readWorkerMeta } from '@kinqs/brainrouter-core/worker';
import { localToolSpecsFromExecutors, isProtectedCoreTool } from '@kinqs/brainrouter-core/tool';
import { reconcileStaleBackgroundTasks } from '@kinqs/brainrouter-core/background';
import { desktopSessionModePatchFromArgs, mergeSessionModePrefs } from './sessionModeBridge.js';
// DESK-5w — stale-task reconcile is the CLI's shared, unit-tested function
// (brainrouter-cli/src/runtime/backgroundReconcile.ts) so the boot path here is
// the exact code covered by backgroundReconcile.test.ts.

async function main(): Promise<void> {
  const workspaceRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || process.cwd();
  // DESK-6w (T4) — resolve how this workspace relates to its owning git repo
  // once (repo name, owning git root, subdir-vs-root). Workspace-scoped status/
  // diff run in workspaceRoot with a `-- .` pathspec: that limits results to the
  // workspace subtree (so a monorepo subfolder or a nested clone inside the repo
  // never pulls in unrelated parent changes) AND keeps paths workspace-relative
  // for the renderer. `workspaceGitScope` is for repo-root ops (worktrees) later.
  const wsGit = resolveWorkspaceGit(workspaceRoot);
  const fileListCache = new WorkspaceFileListCache();
  const listWorkspaceFilesCached = async (args: Record<string, unknown>): Promise<WorkspaceFileListResult> => {
    const refresh = args.refresh === true || args.force === true;
    const cached = refresh ? null : fileListCache.get(workspaceRoot);
    if (cached) return cached;

    const generatedAt = Date.now();
    const tracked = await git(['ls-files'], workspaceRoot);
    const untracked = await git(['ls-files', '--others', '--exclude-standard'], workspaceRoot);
    const all = [...new Set((tracked + '\n' + untracked).split('\n').filter(Boolean))].sort();
    const result: WorkspaceFileListResult = all.length > 0
      ? { files: all.slice(0, 3000), truncated: all.length > 3000, source: 'git', generatedAt }
      : { ...listWorkspaceFiles(workspaceRoot, { limit: 3000 }), generatedAt };

    if (result.error) return result;
    return fileListCache.set(workspaceRoot, result);
  };
  // DESK-5w — clear phantom "running" background tasks left by a previous,
  // now-dead host BEFORE anything queries the fleet (the renderer polls it on
  // boot). In-process actors don't survive a restart; their on-disk state does.
  try {
    const r = reconcileStaleBackgroundTasks(workspaceRoot);
    if (r.sessions + r.workers + r.runs > 0) {
      console.error(`[brainrouter-desktop host] reconciled stale tasks on boot: ${r.sessions} agents, ${r.workers} workers, ${r.runs} workflows`);
    }
    // Durable plan-revision/review/attachment tasks run in-process too — a
    // restart orphans any left running, so flip them to failed on boot.
    const orphaned = reconcileBackgroundTasks(workspaceRoot, pidAlive);
    if (orphaned > 0) console.error(`[brainrouter-desktop host] reconciled ${orphaned} orphaned durable task(s) on boot`);
  } catch { /* best-effort */ }
  // utilityProcess gives us process.parentPort; plain `node host.js` (dev
  // smoke) falls back to a console sink so the bootstrap is runnable solo.
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  const send = port
    ? (msg: unknown) => port.postMessage(msg)
    : (msg: unknown) => console.log(JSON.stringify(msg));
  const computerUseBridge = createComputerUseBridge(port);
  const secretBridge = createSecretBridge(port);
  // First-class browser control follows the same correlated parent-port pattern
  // as computer-use, but targets the window-owned visible WebContentsView tab.
  // Plain node/CLI hosts have no parent port and therefore advertise no tools.
  const browserControlBridge = port ? createBrowserControlBridge(port, { idPrefix: 'desktop-browser' }) : undefined;
  const browserPortFor = (sessionKey: () => string): BrowserControlPort | undefined => browserControlBridge
    ? {
        request: (command, options = {}) => browserControlBridge.request(command, {
          ...options,
          sessionKey: sessionKey(),
        }),
      }
    : undefined;

  // Identical boot recipe to `brainrouter chat` (index.ts): config → llm →
  // pool.connectAll(profiles) → Agent. Offline MCP does not block (same
  // semantics as the CLI's non-strict mode).
  let config = loadConfig();
  let accountConfig = config as typeof config & {
    cli?: { account?: {
      url?: string;
      jwt?: string;
      refreshToken?: string;
      userId?: string;
      orgId?: string;
    } } & Record<string, unknown>;
  };
  // ADR-032 D8 — repair a stale/missing org header before the first MCP
  // connection. The config can predate org-aware transport; the local learned
  // tenant already reads this account field, so boot must make central match.
  const bootOrgId = String(accountConfig.cli?.account?.orgId ?? '').trim();
  let boundBrainOrgId = bootOrgId;
  const synchronizedBootConfig = withAccountOrgId(config, bootOrgId);
  if (synchronizedBootConfig.changed) {
    config = synchronizedBootConfig.next as typeof config;
    accountConfig = config as typeof accountConfig;
    saveConfig(config);
    _resetCliKnobsCache();
  }
  let accountAccessToken = await secretBridge?.get('account:access-token').catch(() => undefined);
  // One-time migration from the former plaintext config fields. A credential is
  // removed only after Electron main confirms OS-protected storage succeeded.
  const legacyAccessToken = String(accountConfig.cli?.account?.jwt ?? '').trim();
  const legacyRefreshToken = String(accountConfig.cli?.account?.refreshToken ?? '').trim();
  if (!accountAccessToken && legacyAccessToken && secretBridge) {
    try {
      await secretBridge.set('account:access-token', legacyAccessToken);
      if (legacyRefreshToken) await secretBridge.set('account:refresh-token', legacyRefreshToken);
      accountAccessToken = legacyAccessToken;
      if (accountConfig.cli?.account) {
        delete accountConfig.cli.account.jwt;
        delete accountConfig.cli.account.refreshToken;
        saveConfig(accountConfig);
      }
    } catch { /* keep the legacy value until secure storage becomes available */ }
  }
  let accountModelCatalog: DesktopAccountModelCatalog | null = null;
  let accountModelCatalogAt = 0;
  let accountModelCatalogRefresh: Promise<DesktopAccountModelCatalog> | null = null;
  const accountContext = (): BrainRouterAccountContext | null => {
    const fresh = loadConfig();
    const configured = resolveBrainRouterAccountApi(fresh);
    const baseUrl = configured?.baseUrl ?? resolveBrainRouterAccountBaseUrl(fresh);
    // Prefer the durable per-user API key from the active BrainRouter profile.
    // The secure access token is normally a short-lived JWT and may expire while
    // the desktop stays open; it remains a fallback for profiles without a key.
    const apiKey = configured?.apiKey ?? accountAccessToken;
    const account = (fresh as { cli?: { account?: { orgId?: unknown } } }).cli?.account;
    const orgId = typeof account?.orgId === 'string' ? account.orgId.trim() : '';
    return baseUrl && apiKey
      ? { baseUrl, apiKey, orgId }
      : null;
  };
  const desktopLearningIdentityConfig = (
    candidate: ReturnType<typeof loadConfig>,
  ): DesktopLearningIdentityConfig => {
    const account = (candidate as {
      cli?: { account?: { userId?: unknown; orgId?: unknown } };
    }).cli?.account;
    const userId = typeof account?.userId === 'string' ? account.userId.trim() : '';
    const orgId = typeof account?.orgId === 'string' ? account.orgId.trim() : '';
    const servers = candidate.servers ?? {};
    const selectedServers = Object.fromEntries(
      selectMcpServerIds(servers, candidate.activeServer)
        .map((id) => [id, servers[id]]),
    );
    return {
      servers: selectedServers,
      ...(userId ? { expectedUserId: userId } : {}),
      ...(orgId ? { expectedOrgId: orgId } : {}),
    };
  };
  // An authenticated profile never inherits config.json user tenancy. It
  // starts in an isolated, disabled partition until the custom host channel
  // returns the identity pinned by the server session.
  let learningBinding = initialDesktopLearningBinding(desktopLearningIdentityConfig(config));
  const learnedTenant = (): { userId: string; orgId: string | null } => ({
    userId: learningBinding.tenant.userId,
    orgId: learningBinding.tenant.orgId ?? null,
  });
  // Synchronous, no-network read of the last-known managed catalog — lets the
  // config snapshot return instantly (BYOK/router models render immediately) while
  // the real refresh runs in the background.
  const peekAccountModelCatalog = (): DesktopAccountModelCatalog =>
    accountModelCatalog ?? emptyAccountModelCatalog(accountContext() !== null);
  // Keep config.providers.brainrouter synced to the managed catalog so the router
  // resolves BrainRouter at turn time. Runs on the (background) catalog refresh,
  // NOT on the snapshot critical path. Field-level change detection avoids churn.
  const syncBrainrouterProvider = (catalog: DesktopAccountModelCatalog): void => {
    try {
      const cfg = loadConfig() as typeof accountConfig & { providers?: Record<string, LLMConfig>; servers?: Record<string, { identity?: string; apiKey?: string }> };
      const account = resolveBrainRouterAccountApi(cfg);
      const ids = catalog.signedIn ? catalog.models.map((m) => m.id) : [];
      const providers = (cfg.providers = (cfg.providers ?? {}) as Record<string, LLMConfig>);
      const desired: LLMConfig | undefined = (account && ids.length)
        ? { provider: 'brainrouter', endpoint: `${account.baseUrl}/v1/chat/completions`, apiKey: account.apiKey, model: ids[0], models: ids }
        : undefined;
      const current = providers.brainrouter;
      const unchanged = !!desired && !!current && current.endpoint === desired.endpoint && current.apiKey === desired.apiKey
        && current.model === desired.model && JSON.stringify(current.models ?? []) === JSON.stringify(desired.models ?? []);
      if (desired && !unchanged) { providers.brainrouter = desired; saveConfig(cfg as never); }
      else if (!desired && current) { delete providers.brainrouter; saveConfig(cfg as never); }
    } catch { /* best effort — the picker still works from the live catalog */ }
  };
  const refreshAccountModelCatalog = async (force = false): Promise<DesktopAccountModelCatalog> => {
    const now = Date.now();
    if (!force && accountModelCatalog && now - accountModelCatalogAt < 30_000) return accountModelCatalog;
    // Config snapshot, the 30s renderer poll, and opening the model menu can all
    // request a refresh together. Coalesce them into one bounded network call.
    if (accountModelCatalogRefresh) return accountModelCatalogRefresh;
    const pending = (async (): Promise<DesktopAccountModelCatalog> => {
      if (force || !accountAccessToken) {
        accountAccessToken = await secretBridge?.get('account:access-token').catch(() => undefined);
      }
      accountModelCatalog = await fetchAccountModelCatalog(accountContext(), accountModelCatalog);
      accountModelCatalogAt = Date.now();
      syncBrainrouterProvider(accountModelCatalog);
      return accountModelCatalog;
    })();
    accountModelCatalogRefresh = pending;
    try {
      return await pending;
    } finally {
      if (accountModelCatalogRefresh === pending) accountModelCatalogRefresh = null;
    }
  };
  let llm: LLMConfig = config.llm || { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
  const mcpClient = new McpClientPool();
  let sessionMessaging: DesktopSessionMessaging | undefined;
  const resolveLearningIdentity = async (
    candidate: ReturnType<typeof loadConfig> = loadConfig(),
  ): Promise<typeof learningBinding> => {
    const resolved = await resolveDesktopLearningBinding({
      config: desktopLearningIdentityConfig(candidate),
      mcpClient,
    });
    learningBinding = resolved;
    if (resolved.source === 'server' && resolved.enabled) {
      // With no explicit org header the backend pins its default org. The
      // custom identity result is the authoritative transport binding.
      boundBrainOrgId = resolved.tenant.orgId ?? '';
    } else if (resolved.source === 'local') {
      boundBrainOrgId = '';
    }
    return resolved;
  };
  // PERF — do NOT block boot on MCP connect. The renderer gates its account/model
  // queries on the host's first event, and connectAll waits for the SLOWEST
  // configured server (5s cap, longer if one connects then stalls) — so awaiting
  // it here made account loading slow on every launch. Connect in the background;
  // local tools work immediately, remote tools light up as servers come online,
  // and the brain-dependent boot steps run once the pool is ready.
  const mcpReady = mcpClient.connectAll(
    desktopLearningIdentityConfig(config).servers,
    llm,
    { timeoutMs: 5_000 },
  )
    .then(() => {
      mcpClient.startReconnectSupervisor(); // WS9 — auto-reconnect dropped MCP servers in the background
    })
    .catch(() => { /* offline-mode: local tools only, same as the CLI */ })
    // Resolve even after an offline connect attempt: hosted profiles remain in
    // their isolated disabled partition, while no-profile installs stay local.
    .then(() => resolveLearningIdentity(config));
  void mcpReady;

  // REMOTE-BRAIN Phase 3d — call a brain Atlas tool via the MCP pool, parsing its
  // JSON text result. Best-effort: null on any failure so the local artifact path
  // always remains the fallback.
  const callBrainAtlas = async (tool: string, args: Record<string, unknown>): Promise<any | null> => {
    try {
      const res = await mcpClient.callTool(tool, args);
      if (!res || res.isError) return null;
      const text = res?.content?.[0]?.text;
      return typeof text === 'string' && text.trim() ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  // DESK-3 — the approval/choice port: agent asks become interaction-request
  // events; the renderer's dialogs answer them. Shares the hostCore broker so
  // interrupt/shutdown dismiss pending dialogs fail-closed.
  const broker = new InteractionBroker();
  // One host-owned PTY registry backs both the Terminal panel and the
  // top-level agent's bounded terminal inspection/control tools.
  const ptyRegistry = new PtyRegistry({ workspaceRoot });
  // DESK-5v — interaction-request events ride a separate seq namespace AND
  // carry the ASKING agent's own sessionKey, so an approval raised by a
  // background turn surfaces against the right chat (same `send` wire).
  let portSeq = 1_000_000; // offset so port events never collide with core seq
  const emitPortFor = (
    sessionKey: string,
    e: { kind: 'interaction-request'; request: import('@kinqs/brainrouter-agent-protocol').InteractionRequest },
  ): void => send({ seq: ++portSeq, ts: Date.now(), sessionKey, event: e });
  const emitInteractionResolvedFor = (sessionKey: string, id: string): void =>
    send({ seq: ++portSeq, ts: Date.now(), sessionKey, event: { kind: 'interaction-resolved', id } });
  // EXTENSIONS — activate code-level extensions before the first turn (workspace
  // tier gated on project trust). Best-effort; never blocks the host boot.
  await loadExtensions(workspaceRoot).catch(() => undefined);
  let agent: Agent;
  agent = new Agent(mcpClient, llm, {
    workspaceRoot,
    launchCwd: workspaceRoot,
    learnedTenant: learnedTenant(),
    learningEnabled: learningBinding.enabled,
    interactionPort: createBrokerPort(broker, (e) => emitPortFor(agent.sessionKey, e)),
    computerUsePort: computerUseBridge,
    browserControlPort: browserPortFor(() => agent.sessionKey),
    terminalUsePort: ptyRegistry,
  });
  // DESK-5v — the agent the user is currently VIEWING. hostCore keeps a pool of
  // agents (one per running/active session) and tells us which is active via
  // onActiveAgentChange; every read-only query below reports THIS agent so the
  // ring/tokens/recap/transcript track the chat on screen, not a background one.
  let activeAgent = agent;
  const activeTenantBindingError = (): string | null => {
    if (learningBinding.source === 'unresolved-authenticated-profile') {
      return learningBinding.warning
        ?? 'Learning is disabled until the authenticated BrainRouter identity is verified.';
    }
    const expectedUserId = learningBinding.tenant.userId;
    const expectedOrgId = learningBinding.tenant.orgId ?? '';
    const agentUserId = activeAgent.learnedTenant?.userId?.trim() || 'local';
    const agentOrgId = activeAgent.learnedTenant?.orgId ?? '';
    const hostTransportMatches = learningBinding.source !== 'server'
      || expectedOrgId === boundBrainOrgId;
    if (
      expectedUserId === agentUserId
      && expectedOrgId === agentOrgId
      && activeAgent.learningEnabled === learningBinding.enabled
      && hostTransportMatches
    ) return null;
    return 'The active account or organization is still being applied to this workspace. Wait for the switch to finish and try again.';
  };
  const humanCorrectionIngress = createAuthenticatedHumanCorrectionIngress({
    readBinding: () => {
      return {
        authenticated: learningBinding.source === 'server' && learningBinding.enabled,
        accountUserId: learningBinding.tenant.userId,
        accountOrgId: learningBinding.tenant.orgId,
        tenant: activeAgent.learnedTenant ?? { userId: 'local', orgId: null },
        sessionKey: activeAgent.sessionKey,
        bindingError: activeTenantBindingError(),
      };
    },
    record: recordHumanCorrection,
  });
  const loadGlobalLlm = (): LLMConfig => {
    const fresh = loadConfig();
    llm = fresh.llm ?? llm;
    return llm;
  };
  const llmForSession = (sessionKey: string): LLMConfig => {
    const base = loadGlobalLlm();
    const resolved = resolveSessionLlmConfig(base, workspaceRoot, sessionKey);
    if (resolved.provider === 'brainrouter') {
      const account = accountContext();
      return {
        ...resolved,
        apiKey: account?.apiKey ?? '',
        endpoint: account ? `${account.baseUrl}/v1/chat/completions` : resolved.endpoint,
      };
    }
    // A session can run a DIFFERENT provider than the global default; the session
    // runtime stores provider/model/endpoint but never a secret, so the global
    // apiKey would be wrong. Resolve the chosen provider's key from the saved
    // connections (match by provider + endpoint, then provider alone).
    if (resolved.provider !== base.provider || (resolved.endpoint ?? '') !== (base.endpoint ?? '')) {
      const conns = Object.values(loadConfig().providers ?? {});
      const match =
        conns.find((p) => p.provider === resolved.provider && (p.endpoint ?? '') === (resolved.endpoint ?? '')) ??
        conns.find((p) => p.provider === resolved.provider);
      if (match?.apiKey) return { ...resolved, apiKey: match.apiKey, endpoint: resolved.endpoint ?? match.endpoint };
    }
    return resolved;
  };
  // Item 10 / per-session provider — resolve a named saved connection to a full
  // LLM config (incl. its apiKey, main-process only). Used to (re)build the active
  // agent when the user picks a model from another provider.
  const resolveProviderLlm = async (providerName: string, model: string): Promise<LLMConfig | undefined> => {
    if (providerName === 'brainrouter-account') {
      const catalog = await refreshAccountModelCatalog(true);
      const account = accountContext();
      if (!account || !catalog.models.some((entry) => entry.id === model && entry.enabled)) return undefined;
      return {
        provider: 'brainrouter',
        apiKey: account.apiKey,
        model,
        endpoint: `${account.baseUrl}/v1/chat/completions`,
      };
    }
    const p = loadConfig().providers?.[providerName];
    if (!p) return undefined;
    return { provider: p.provider, apiKey: p.apiKey, model: model || p.model, endpoint: p.endpoint };
  };
  const syncActiveSessionLlm = (base: LLMConfig = loadGlobalLlm()): LLMConfig => {
    // Restore the host-only credential for the built-in BrainRouter provider;
    // session runtime persistence intentionally holds only safe metadata.
    const resolved = resolveSessionLlmConfig(base, workspaceRoot, activeAgent.sessionKey);
    const account = resolved.provider === 'brainrouter' ? accountContext() : null;
    const next = account
      ? { ...resolved, apiKey: account.apiKey, endpoint: `${account.baseUrl}/v1/chat/completions` }
      : resolved;
    activeAgent.setLLMConfig(next);
    return next;
  };
  // DESK-5v — an independent agent for a SECOND, concurrent session: shares the
  // one MCP pool / llm / broker but keeps its own history, counters and key, so
  // two chats can run turns at the same time.
  // Item 10 — the global runtime is the config.json LLM; a session can override
  // provider/model/endpoint (sessionRuntimeStore). spawnAgent resolves THIS
  // session's runtime so concurrent chats can run different models/providers.
  const spawnAgent = (sessionKey: string): AgentLike => {
    let a: Agent;
    a = new Agent(mcpClient, llmForSession(sessionKey), {
      workspaceRoot,
      launchCwd: workspaceRoot,
      learnedTenant: learnedTenant(),
      learningEnabled: learningBinding.enabled,
      interactionPort: createBrokerPort(broker, (e) => emitPortFor(a.sessionKey, e)),
      computerUsePort: computerUseBridge,
      browserControlPort: browserPortFor(() => a.sessionKey),
      terminalUsePort: ptyRegistry,
    });
    a.sessionKey = sessionKey;
    return a as unknown as AgentLike;
  };
  // §6 — the local reviewer runs in an ISOLATED, READ-ONLY, NON-PROMPTING agent:
  //  - a deny-all interaction port (confirm→false, choice→null) that NEVER emits
  //    an interaction-request to the UI, so review can't pop an approval dialog;
  //  - read access mode (look-only: no file writes, no shell, no mutating tools);
  //  - NO network-read tools: the reviewer now actively reads the codebase to
  //    verify findings AND ingests an untrusted diff + repo-controlled REVIEW.md,
  //    so `fetch_url`/`web_search` are denied to close the read-a-secret →
  //    exfiltrate-over-the-network surface. A local-diff review never needs the web.
  const spawnReviewer = (
    sessionKey?: string,
    reflectionSystemPrompt?: string,
    maxModelCallsPerTurn = 2,
  ): AgentLike => {
    const reflection = Boolean(reflectionSystemPrompt);
    const a = new Agent(mcpClient, llmForSession('review'), {
      workspaceRoot,
      launchCwd: workspaceRoot,
      learnedTenant: learnedTenant(),
      learningEnabled: learningBinding.enabled,
      silent: true,
      enableRecall: false,
      reviewSourceSafety: true,
      maxModelCallsPerTurn,
      maxLlmReconnectsPerCall: 0,
      roleOverlay: reflectionSystemPrompt ?? UNTRUSTED_REVIEW_EVIDENCE_RULE,
      interactionPort: { confirm: async () => false, choice: async () => null },
      authorityToolCeiling: {
        // LSP may follow workspace config/imports outside the checkout or load
        // plugins. Reviewer evidence stays on canonically-confined file tools.
        local: reflection ? [] : ['read_file', 'list_dir', 'grep_search', 'glob_files'],
        mcp: [],
      },
      disallowedTools: ['fetch_url', 'web_search', 'mcp_call'],
    });
    // A STABLE per-task `review:<id>` key (filtered from the picker by
    // isInternalSessionKey) so the reviewer's turn transcript is durably
    // findable as the task's conversation; falls back to a timestamp key.
    a.sessionKey = sessionKey ?? `review:${Date.now().toString(36)}`;
    try { (a as { setAccessMode?: (m: string) => void }).setAccessMode?.('read'); } catch { /* older agent */ }
    return a as unknown as AgentLike;
  };
  // A WRITE-capable background agent for a plan revision: its own internal
  // session key (filtered from the picker) so its turn transcript is the task's
  // conversation, but its `update_plan` is intercepted (onPlanUpdate) and the
  // host writes the result into the USER's session plan. Non-prompting.
  const spawnTaskAgent = (sessionKey: string, access: 'read' | 'write'): AgentLike => {
    const a = new Agent(mcpClient, llmForSession(sessionKey), {
      workspaceRoot,
      launchCwd: workspaceRoot,
      learnedTenant: learnedTenant(),
      learningEnabled: learningBinding.enabled,
      interactionPort: { confirm: async () => false, choice: async () => null },
    });
    a.sessionKey = sessionKey;
    try { (a as { setAccessMode?: (m: string) => void }).setAccessMode?.(access); } catch { /* older agent */ }
    return a as unknown as AgentLike;
  };

  const activeMemorySessionKey = (): string => activeAgent?.sessionKey ?? agent.sessionKey;
  const lifecycleActionFor = (change: string): RecordLifecycleAction => {
    const c = change.toLowerCase();
    if (c === 'created') return 'created';
    if (c.includes('status')) return 'status-changed';
    if (c.includes('comment')) return 'comment-added';
    if (c.includes('saved')) return 'saved';
    if (c.includes('export')) return 'exported';
    return 'updated';
  };
  const emitRecordEvent = (event: AgentEvent): void => {
    send({ seq: ++portSeq, ts: Date.now(), sessionKey: activeMemorySessionKey(), event });
  };

  // FILES-LIVE — watch the workspace and push a debounced `files-changed` so the
  // Files / Changes panel refreshes itself (no manual Refresh). Invalidate the
  // file-list cache first so the next list-files rebuilds. Best-effort; degrades
  // to the existing git poll where recursive fs.watch is unsupported (Linux).
  const stopWorkspaceWatcher = startWorkspaceWatcher(workspaceRoot, () => {
    fileListCache.invalidate(workspaceRoot);
    send({ seq: ++portSeq, ts: Date.now(), sessionKey: activeMemorySessionKey(), event: { kind: 'files-changed' } });
  });

  // DURABLE BACKGROUND TASKS (0.4.15 workflow gaps) — task lifecycle events ride
  // the same wire on the TASK's OWN sessionKey so they surface against the right
  // chat, and the renderer's global active-task state (sidebar dots, Tasks panel)
  // stays correct across workspace/session switches.
  const taskEventView = (t: BackgroundTaskRecord): BackgroundTaskEventView => ({
    id: t.id, kind: t.kind, status: t.status, title: t.title,
    workspaceRoot, sessionKey: t.sessionKey,
    requirementId: t.requirementId, planId: t.planId, artifactId: t.artifactId, attachmentId: t.attachmentId,
    transcript: t.transcript, phase: currentPhase(t), error: t.error,
    createdAt: t.createdAt, startedAt: t.startedAt, updatedAt: t.updatedAt, completedAt: t.completedAt,
  });
  const emitTaskEvent = (action: 'created' | 'progress' | 'updated' | 'completed' | 'failed' | 'canceled', t: BackgroundTaskRecord): void => {
    send({ seq: ++portSeq, ts: Date.now(), sessionKey: t.sessionKey, event: { kind: 'task-event', action, task: taskEventView(t) } });
  };
  /** Append a progress phase + emit the live update in one step. */
  const taskProgress = (id: string, phase: string, note?: string): void => {
    const t = appendTaskProgress(workspaceRoot, id, { phase, note });
    if (t) emitTaskEvent('progress', t);
  };

  // VERIFICATION SCOPING (workflow-gaps follow-up) — surface the build/test/
  // typecheck/lint commands a MAIN turn runs as durable `verification` tasks,
  // keyed by THIS host's workspaceRoot + the turn's sessionKey + the task id.
  // Because the work runs inside the turn (which the host pool keeps alive on a
  // workspace switch), the verification keeps running in the edited workspace and
  // the task stays visible for that workspace even while another is active —
  // clicking it reopens the command + output. We match a run_command's
  // tool-start→tool-end by callId. Best-effort throughout.
  const verifyTitle = (command: string): string => {
    const head = command.replace(/\s+/g, ' ').trim();
    return `Verify — ${head.length > 64 ? `${head.slice(0, 63)}…` : head}`;
  };
  const verifyTasksByCall = new Map<string, { taskId: string; verifyKey: string; command: string }>();
  // §goal-autonomy — consecutive prose-only "strikes" per session (anti-spin),
  // mirroring the CLI Ink loop's goalNoToolStrikes counter.
  const goalStrikes = new Map<string, number>();
  const observeVerificationEvent = (sessionKey: string, event: AgentEvent): void => {
    if (event.kind === 'tool-start') {
      if (event.tool !== 'run_command' || !event.callId) return;
      const command = typeof event.args?.command === 'string' ? event.args.command : '';
      if (!command || classifyForVerification('run_command', command) !== 'verified') return;
      const task = createBackgroundTask(workspaceRoot, { kind: 'verification', title: verifyTitle(command), sessionKey, status: 'running' });
      const verifyKey = `internal:verify:${task.id}`;
      const withTranscript = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: verifyKey } }) ?? task;
      verifyTasksByCall.set(event.callId, { taskId: task.id, verifyKey, command });
      try { appendTranscriptEntry(workspaceRoot, verifyKey, { role: 'user', content: `$ ${command}` }); } catch { /* advisory */ }
      taskProgress(task.id, 'running', command.slice(0, 80));
      emitTaskEvent('created', withTranscript);
      recordTelemetry({ name: TELEMETRY_EVENTS.task_started, workspaceRoot, sessionKey, taskKind: 'verification' });
    } else if (event.kind === 'tool-end') {
      if (!event.callId) return;
      const entry = verifyTasksByCall.get(event.callId);
      if (!entry) return;
      verifyTasksByCall.delete(event.callId);
      const ok = event.ok;
      const output = String(event.preview || event.summary || '').slice(0, 8_000);
      try { appendTranscriptEntry(workspaceRoot, entry.verifyKey, { role: 'assistant', content: `${ok ? '✓ passed' : '✗ failed'}\n\n${output}` }); } catch { /* advisory */ }
      const done = updateBackgroundTask(workspaceRoot, entry.taskId, {
        status: ok ? 'completed' : 'failed',
        error: ok ? undefined : (event.summary || 'Verification failed.'),
        result: { ok, command: entry.command, summary: event.summary },
      });
      if (done) emitTaskEvent(ok ? 'completed' : 'failed', done);
      recordTelemetry({ name: ok ? TELEMETRY_EVENTS.task_completed : TELEMETRY_EVENTS.task_failed, workspaceRoot, sessionKey, taskKind: 'verification', ok });
    }
  };

  const captureRequirementNote = async (record: RequirementRecord, change: string): Promise<void> => {
    let memoryId: string | undefined;
    try {
      memoryId = (await emitAgentEvent(
        { mcpClient, sessionKey: activeMemorySessionKey() },
        {
          kind: 'agent_output',
          summary: `Requirement ${record.id}: ${record.title} [${record.status}] (${change})`,
          payload: {
            requirementId: record.id,
            title: record.title,
            status: record.status,
            priority: record.priority,
            acceptanceCriteria: record.acceptanceCriteria,
            change,
          },
        },
      )) ?? undefined;
      if (memoryId) linkRequirement(workspaceRoot, record.id, { memoryId });
    } catch { /* advisory — never break the desktop action */ }
    const provenance = { linkedMemoryIds: memoryId ? [memoryId] : [], actor: 'desktop', reason: change };
    emitRecordEvent({
      kind: 'requirement-event',
      action: lifecycleActionFor(change),
      requirementId: record.id,
      title: record.title,
      status: record.status,
      provenance,
    });
    emitRecordEvent({ kind: 'provenance', subjectKind: 'requirement', subjectId: record.id, provenance });
  };

  const captureAnnotationNote = async (record: AnnotationRecord, change: string): Promise<void> => {
    let memoryId: string | undefined;
    try {
      memoryId = (await emitAnnotationCapture(
        { mcpClient, sessionKey: activeMemorySessionKey() },
        {
          annotationId: record.id,
          title: record.body.slice(0, 120),
          body: record.body,
          targetKind: record.type,
          targetId: record.targetId,
          filePath: record.anchor?.filePath,
          startLine: record.anchor?.startLine,
          endLine: record.anchor?.endLine,
          severity: record.severity,
          status: record.status,
        },
      )) ?? undefined;
      if (memoryId) linkAnnotation(workspaceRoot, record.id, { memoryId });
    } catch { /* advisory — never break the desktop action */ }
    const provenance = { linkedMemoryIds: memoryId ? [memoryId] : [], actor: 'desktop', reason: change };
    emitRecordEvent({
      kind: 'annotation-event',
      action: lifecycleActionFor(change),
      annotationId: record.id,
      targetKind: record.type,
      targetId: record.targetId,
      status: record.status,
      provenance,
    });
    emitRecordEvent({ kind: 'provenance', subjectKind: 'annotation', subjectId: record.id, provenance });
  };

  const captureAnnotationExportNote = async (records: AnnotationRecord[]): Promise<void> => {
    if (records.length === 0) return;
    try {
      const memoryId = await emitAgentEvent(
        { mcpClient, sessionKey: activeMemorySessionKey() },
        {
          kind: 'agent_output',
          summary: `Annotation export — ${records.length} annotation(s) returned to session`,
          payload: {
            exported: records.length,
            annotationIds: records.map((r) => r.id),
            markdown: annotationsToMarkdown(records),
          },
        },
      );
      if (memoryId) {
        for (const record of records) linkAnnotation(workspaceRoot, record.id, { memoryId });
      }
    } catch { /* advisory — never break the desktop action */ }
  };

  const captureArtifactNote = async (record: ArtifactRecord, change: string): Promise<void> => {
    let memoryId: string | undefined;
    try {
      memoryId = (await emitArtifactCapture(
        { mcpClient, sessionKey: activeMemorySessionKey() },
        {
          artifactId: record.id,
          title: record.title,
          summary: record.summary,
          artifactKind: record.kind,
          format: record.format,
          status: record.status,
          requirementId: record.requirementId,
          taskId: record.taskId,
        },
      )) ?? undefined;
      if (memoryId) linkArtifact(workspaceRoot, record.id, { memoryId });
    } catch { /* advisory — never break the desktop action */ }
    const provenance = { linkedMemoryIds: memoryId ? [memoryId] : [], actor: 'desktop', reason: change };
    emitRecordEvent({
      kind: 'artifact-event',
      action: lifecycleActionFor(change),
      artifactId: record.id,
      title: record.title,
      status: record.status,
      format: record.format,
      path: record.path,
      provenance,
    });
    emitRecordEvent({ kind: 'provenance', subjectKind: 'artifact', subjectId: record.id, provenance });
  };

  const hostedAgents = new HostedAgentManager({
    workspaceRoot,
    ptyRegistry,
    onTransition: (session) => {
      send({
        seq: ++portSeq,
        ts: Date.now(),
        sessionKey: session.sessionKey,
        event: { kind: 'status', text: `${session.adapterId}: ${session.status}` },
      });
      try {
        appendTranscriptEntry(workspaceRoot, session.sessionKey, {
          role: 'system',
          content: `[hosted-agent] ${session.adapterId} status: ${session.status}`,
        });
      } catch { /* status persistence is advisory */ }
    },
  });
  const remoteWorktrees = new RemoteWorktreeManager(workspaceRoot);
  const fanoutManager = new FanoutManager({ workspaceRoot, hostedAgents, remoteWorktrees });
  const mobileRelay = new MobileRelayServer({
    status: () => fanoutManager.list(),
    terminalSnapshot: (candidateId) => {
      const attached = fanoutManager.attach(candidateId);
      return attached ? { snapshot: attached.snapshot, start: attached.start, next: attached.next, alive: attached.alive } : null;
    },
    terminalInput: (candidateId, data) => fanoutManager.writeTerminal(candidateId, data),
    agentControl: (candidateId, action, text) => fanoutManager.control(candidateId, action, text),
    // Account-based pairing: a peer is trusted if its BrainRouter account token
    // resolves to the SAME account as this desktop — proven by the account-scoped
    // GET /api/sessions returning THIS desktop's own session key (another
    // account's token never sees it). No manual QR required.
    verifyAccountPeer: async (accountToken) => {
      const api = resolveBrainRouterAccountApi(loadConfig());
      const ownKey = getBrainSessionKey();
      if (!api?.baseUrl || !ownKey) return false;
      const base = api.baseUrl.replace(/\/+$/, '');
      // The account token is a long-lived credential — never send it over
      // cleartext http (except loopback dev) and never follow a redirect that
      // could carry it to an attacker host (CWE-601).
      let u: URL; try { u = new URL(base); } catch { return false; }
      const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return false;
      try {
        const res = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${accountToken}` }, redirect: 'error' });
        if (!res.ok) return false;
        const data = (await res.json()) as { sessions?: Array<{ sessionKey?: string }> };
        return Array.isArray(data.sessions) && data.sessions.some((s) => s.sessionKey === ownKey);
      } catch { return false; }
    },
  });
  // Enrolled-device broker client (spec §9, Task 23): outbound WSS to the
  // remote-relay edge; attached sockets reuse mobileRelay's E2EE/RPC allowlist.
  const remoteAccess = createRemoteAccessClient(mobileRelay);
  // ADR-043 C5 — the edge egress tunnel client. Gated OFF unless
  // `cli.remote.egressTunnel` is set AND the device is enrolled; when on it holds
  // a standing control channel to the gateway and relays provider traffic through
  // this device. (Org-switch re-hello is a documented follow-up; a stale binding
  // is fail-safe — the server just won't route the new org's traffic here.)
  const egressTunnel = createEgressTunnelClient();
  if (egressTunnelEnabled(loadConfig()) && remoteAccess.isEnrolled()) egressTunnel.start();
  // Per-endpoint /models cache ('' = the active llm; otherwise a named provider).
  const modelsCacheByKey = new Map<string, { models: string[]; at: number }>();
  // DESK-5d — PR state cache (gh is a network call; the sidebar refreshes often).
  let prCache: { at: number; pr: { number: number; state: string; title?: string } | null } | null = null;
  // §session-pr — cached all-states PR rows (number/state/headRefName/isDraft/
  // mergeable) used to match each session to its PR; ~60s TTL, polled by the
  // renderer on its existing 25s cadence.
  let prStatusMapCache: { at: number; prs: unknown[] } | null = null;
  // DESK-6t — short-lived transcript-read cache. Resuming a session reads the
  // transcript (for lazy-load bookkeeping) and the renderer immediately reads it
  // AGAIN to render — this memo makes that a single read. Also stashes a token
  // estimate so the context ring is right on a lazily-resumed (not-yet-loaded)
  // chat. 3s TTL: long enough for resume→render, short enough to stay fresh.
  type TxEntry = { role?: string; content?: unknown; name?: string; tool_calls?: unknown[]; tool_call_id?: string; isError?: boolean; timestamp?: string };
  // Short-lived dedup cache for the FULL agent-continuation read (loadHistory).
  // The context-fill estimate no longer reads this (it uses transcriptSizeBytes),
  // so there's no O(n) token loop here anymore.
  const transcriptCache = new Map<string, { entries: TxEntry[]; at: number }>();
  const readTranscriptCached = (key: string): TxEntry[] => {
    const now = Date.now();
    const hit = transcriptCache.get(key);
    if (hit && now - hit.at < 3_000) return hit.entries;
    const entries = loadTranscript(workspaceRoot, key) as TxEntry[];
    transcriptCache.set(key, { entries, at: now });
    if (transcriptCache.size > 8) transcriptCache.delete(transcriptCache.keys().next().value as string);
    return entries;
  };

  // Review v2 helpers (shared by the review-* queries + the commit/push gate).
  const isoNow = (): string => new Date().toISOString();
  const reviewGit = (
    args: string[],
    options: { maxBuffer: number; allowDifference?: boolean },
  ): Promise<string> => new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: options.maxBuffer,
    }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: number | string }) | null)?.code;
      if (!error || (options.allowDifference && code === 1)) {
        resolve(String(stdout ?? ''));
        return;
      }
      reject(new Error(String(stderr ?? '').trim() || error.message || 'git command failed'));
    });
  });
  const collectWorkingDiff = async (): Promise<{ diff: string; files: string[] }> => {
    // Review the complete tracked diff, then append every untracked file as a
    // real no-index diff. The previous first-30-files / 60K global truncation
    // made the omitted tail indistinguishable from clean coverage.
    const repository = await reviewGit(['rev-parse', '--is-inside-work-tree'], { maxBuffer: 64 * 1024 });
    if (repository.trim() !== 'true') throw new Error('The workspace is not a Git worktree.');
    let baseRef = 'HEAD';
    try {
      await reviewGit(['rev-parse', '--verify', 'HEAD'], { maxBuffer: 64 * 1024 });
    } catch {
      baseRef = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // Git's canonical empty tree
    }
    const [trackedDiff, trackedNames, untrackedNames] = await Promise.all([
      reviewGit(['diff', '--binary', baseRef, '--', '.'], { maxBuffer: 128 * 1024 * 1024 }),
      reviewGit(['diff', '--name-only', '-z', baseRef, '--', '.'], { maxBuffer: 8 * 1024 * 1024 }),
      reviewGit(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], { maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const tracked = trackedNames.split('\0').filter((value) => value.length > 0);
    const untracked = untrackedNames.split('\0').filter((value) => value.length > 0);
    const files = [...new Set([...tracked, ...untracked])];
    const additions = new Array<string>(untracked.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, untracked.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= untracked.length) return;
        const file = untracked[index];
        const value = await reviewGit(
          ['diff', '--binary', '--no-index', '--', '/dev/null', file],
          { maxBuffer: 128 * 1024 * 1024, allowDifference: true },
        );
        if (!value.trim()) throw new Error(`Git returned no diff for untracked file ${file}.`);
        additions[index] = value;
      }
    }));
    return { diff: [trackedDiff, ...additions].filter(Boolean).join('\n'), files };
  };
  // Map the model's free-form severities onto the v2 scale.
  const SEV_MAP: Record<string, Severity> = { security: 'critical', critical: 'critical', bug: 'high', high: 'high', perf: 'medium', medium: 'medium', style: 'low', nit: 'low', low: 'low', info: 'info' };
  // Instrumented so the review runs as a VISIBLE background task: `onPhase`
  // streams diff-collection → analysis → findings → verification → completion to
  // the durable task; `reviewerKey` makes the reviewer's turn transcript durably
  // findable as the task's conversation.
  const runReview = async (ctx?: {
    reviewerKey?: string;
    onPhase?: (phase: string, note?: string) => void;
  }): Promise<ReviewRun & { files: number }> => {
    const phase = ctx?.onPhase ?? ((): void => {});
    phase('collecting-diff');
    const { diff, files } = await collectWorkingDiff();
    const base: ReviewRun = {
      id: `rev_${Date.now().toString(36)}`, workspaceRoot, repoRoot: wsGit.gitRoot ?? workspaceRoot,
      baseRef: 'HEAD', headRef: 'WORKTREE', diffHash: hashDiff(diff), createdAt: isoNow(), updatedAt: isoNow(),
      status: 'completed', summary: '', findings: [],
    };
    if (files.length === 0) { phase('completed', 'no working-tree changes'); const r: ReviewRun = { ...base, summary: 'No working-tree changes to review.' }; saveReview(workspaceRoot, r); return { ...r, files: 0 }; }
    phase('analyzing', `${files.length} file(s)`);
    // ATLAS-UNDERSTANDING — prepend a FREE, deterministic blast-radius block. To
    // stay correct across NEW / renamed / deleted files, rebuild the base graph
    // fresh each review (deterministic scan, no LLM) and carry forward cached
    // summaries from the stored graph — so the impact reflects the tree as it is
    // NOW, never a stale snapshot. Falls back to the stored graph if a rebuild
    // fails; NOT saved, so the stored ENRICHED graph (tour/layers) stays intact for
    // the Atlas panel. Empty block on total failure — never blocks the review.
    let atlasGraph = readAtlasGraph(workspaceRoot);
    try { atlasGraph = carryForwardSummaries(buildBaseGraph(workspaceRoot), atlasGraph); } catch { /* keep the stored graph as-is if a rebuild isn't possible */ }
    const changeCtx = buildAtlasChangeContext(atlasGraph, files);
    // REVIEW.md (if present) is surfaced only as fenced, non-authoritative
    // repository evidence. Checkout prose cannot override the review contract.
    const reviewInstr = buildReviewInstructionBlockForDiff(workspaceRoot, diff);
    const noop = (): void => {};
    const cb = { onStatusUpdate: noop, onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop, onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop } as never;
    // Feed graph relationships between changed paths into the deterministic
    // bundler. Edges may JOIN files already in the diff; they can never widen
    // review scope to a path named by untrusted content.
    const changed = new Set(files);
    const nodePath = new Map((atlasGraph?.nodes ?? []).map((node) => [node.id, node.filePath]));
    const graphEdges: Array<[string, string]> = [];
    const graphEdgeKeys = new Set<string>();
    for (const edge of atlasGraph?.edges ?? []) {
      const left = nodePath.get(edge.source);
      const right = nodePath.get(edge.target);
      if (!left || !right || left === right || !changed.has(left) || !changed.has(right)) continue;
      const pair = [left, right].sort() as [string, string];
      const key = `${pair[0]}\u0000${pair[1]}`;
      if (graphEdgeKeys.has(key)) continue;
      graphEdgeKeys.add(key);
      graphEdges.push(pair);
    }

    let local: LocalReviewOrchestrationResult;
    try {
      local = await runLocalReviewOrchestration({
        diff,
        reviewInstructions: reviewInstr,
        changeContext: changeCtx,
        relatedPaths: graphEdges,
        concurrency: 4,
        maxBundleChars: 18_000,
        maxBundles: 40,
        sourceTextForPath: (path) => {
          const source = readBoundedReviewSourceText(workspaceRoot, path);
          return source && !source.truncated ? source.text : null;
        },
        onBundleSettled: (outcome) => phase('analyzing', `${outcome.bundleId}: ${outcome.ok ? 'reviewed' : 'unavailable'}`),
        createTurn: (turnContext) => {
          const suffix = turnContext.phase === 'reflection'
            ? 'reflection'
            : turnContext.bundle.id;
          const reviewer = spawnReviewer(
            ctx?.reviewerKey ? `${ctx.reviewerKey}:raw:${suffix}` : undefined,
            turnContext.phase === 'reflection' ? turnContext.systemPrompt : undefined,
            turnContext.modelCallLimit,
          );
          return {
            // `preplanned` — this turn IS the review. Diff text frequently
            // matches delivery signals and must not be replanned as a write run.
            run: (prompt) => reviewer.runTurn(prompt, cb, { preplanned: true }),
            interrupt: () => reviewer.requestInterrupt?.(),
          };
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      phase('failed', message);
      const r: ReviewRun = { ...base, status: 'failed', summary: `Review failed: ${message}` };
      saveReview(workspaceRoot, r);
      return { ...r, files: files.length };
    }
    phase('findings', 'positioning and reflecting on findings');
    const findings: ReviewFinding[] = local.review.findings.map((f, i) => ({
      id: `f${i}_${Date.now().toString(36)}`, file: f.file, line: f.line ?? undefined, endLine: f.endLine ?? undefined,
      severity: SEV_MAP[String(f.severity ?? '').toLowerCase()] ?? 'medium',
      confidence: f.confidence ?? 70, summary: f.summary,
      details: f.details, suggestion: f.suggestion, codeExcerpt: f.codeExcerpt, diffHunk: f.diffHunk,
      patch: f.patch, status: 'open', canApply: !!f.patch, source: 'ai-review',
      preExisting: f.preExisting || undefined,
    }));
    const reflectionUnavailable = local.review.reflection.required
      && !local.review.reflection.reflected;
    const incomplete = local.review.failedBundles > 0
      || local.review.skippedBundles > 0
      || local.review.canceled
      || local.plan.deferredPaths.length > 0
      || reflectionUnavailable;
    const missing = local.review.failedBundles
      + local.review.skippedBundles
      + local.plan.deferredPaths.length
      + (reflectionUnavailable ? 1 : 0);
    const summary = incomplete
      ? `Review incomplete: ${local.review.reviewedBundles}/${local.plan.bundles.length} bundle(s) reviewed; ${missing} review phase/file unit(s) unavailable.`
      : findings.length === 0
        ? `No issues found across ${files.length} file(s) and ${local.plan.bundles.length} review bundle(s).`
        : `${findings.length} finding(s) across ${files.length} file(s); ${local.review.reflection.reflected ? 'reflection complete' : 'reflection not required'}.`;
    const run: ReviewRun = { ...base, status: incomplete ? 'failed' : 'completed', summary, findings };
    saveReview(workspaceRoot, run);
    // ATLAS-UNDERSTANDING — persist the deterministic change explainer together
    // with the positioned review findings as a durable "Understanding" artifact.
    // It is a SINGLE
    // artifact per workspace, UPDATED (new version) each review rather than piling
    // up a stale copy per run — so it always reflects the current changes, older
    // versions live in its history, and a provenance header records exactly what it
    // describes (date · files · diff hash). Best-effort — never blocks the review.
    if (changeCtx || findings.length > 0 || incomplete) {
      try {
        const UNDERSTANDING_PATH = '.brainrouter/understanding/working-changes.md';
        const header = `> As of ${isoNow().slice(0, 10)} · ${files.length} changed file${files.length === 1 ? '' : 's'} · diff \`${base.diffHash.slice(0, 12)}\`. Regenerated on each review; older versions are in this artifact's history.`;
        const findingLines = incomplete
          ? `## Review coverage\n${summary}`
          : findings.length
            ? ['## Findings', ...findings.map((finding) => `- **${finding.severity}** \`${finding.file}${finding.line ? `:${finding.line}` : ''}\` — ${finding.summary}`)].join('\n')
            : '## Findings\nNo issues found.';
        const doc = [header, changeCtx, findingLines].filter(Boolean).join('\n\n');
        const title = `Understanding — working changes (${files.length} file${files.length === 1 ? '' : 's'})`;
        const existing = Object.values(readArtifactsAll(workspaceRoot)).find((a) => a.path === UNDERSTANDING_PATH);
        if (existing) updateArtifact(workspaceRoot, existing.id, { content: doc, title, status: 'draft' });
        else createArtifact(workspaceRoot, { kind: 'markdown-report', title, content: doc, format: 'markdown', status: 'draft', path: UNDERSTANDING_PATH });
      } catch { /* the artifact is a bonus; the review still stands */ }
    }
    phase(incomplete ? 'failed' : 'completed', summary);
    return { ...run, files: files.length };
  };
  // §2 (workflow gaps) — Review/Re-run review as a VISIBLE durable task. Creates
  // the task, streams phase progress, persists the reviewer transcript (via the
  // stable reviewer key), writes findings + memory provenance + telemetry, and
  // returns the run so the renderer's review panel still paints as before.
  const runReviewTask = async (sessionKey: string): Promise<ReviewRun & { files: number; taskId: string }> => {
    const task = createBackgroundTask(workspaceRoot, { kind: 'review', title: 'Review working changes', sessionKey, status: 'running' });
    const reviewerKey = `review:${task.id}`;
    const withTranscript = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: reviewerKey } }) ?? task;
    emitTaskEvent('created', withTranscript);
    recordTelemetry({ name: TELEMETRY_EVENTS.review_started, workspaceRoot, sessionKey, taskKind: 'review' });
    // §review-visibility — SEED the curated task transcript synchronously so
    // clicking the running task immediately shows the agent at work (not a blank
    // pane while the long review turn computes), then mirror each phase as a
    // readable line. The reviewer's raw turn writes to `${reviewerKey}:raw`.
    const seedReviewTranscript = (role: 'user' | 'assistant', content: string): void => {
      try { appendTranscriptEntry(workspaceRoot, reviewerKey, { role, content }); } catch { /* advisory */ }
    };
    const REVIEW_PHASE_LABELS: Record<string, string> = {
      'collecting-diff': '📂 Collecting the working-tree diff…',
      analyzing: '🔍 Analyzing the changed files for bugs, security, and performance issues…',
      findings: '📝 Parsing the review findings…',
    };
    seedReviewTranscript('user', 'Review the uncommitted working-tree changes for bugs, security issues, and performance problems.');
    const startedAt = Date.now();
    let run: ReviewRun & { files: number };
    try {
      run = await runReview({ reviewerKey, onPhase: (p, n) => {
        taskProgress(task.id, p, n);
        const label = REVIEW_PHASE_LABELS[p];
        if (label) seedReviewTranscript('assistant', n ? `${label} (${n})` : label);
      } });
      seedReviewTranscript('assistant', run.status === 'failed'
        ? `❌ ${run.summary}`
        : run.findings.length === 0
          ? `✅ Review complete — no issues found across ${run.files} file(s).`
          : `✅ Review complete — ${run.findings.length} finding(s) across ${run.files} file(s). See the Review panel for details.`);
    } catch (err) {
      seedReviewTranscript('assistant', `❌ Review failed: ${err instanceof Error ? err.message : String(err)}`);
      const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      if (failed) emitTaskEvent('failed', failed);
      recordTelemetry({ name: TELEMETRY_EVENTS.review_completed, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // Memory provenance for the review run + its findings (best-effort).
    try {
      const memoryId = await emitAgentEvent(
        { mcpClient, sessionKey },
        {
          kind: 'agent_output',
          summary: `Review ${run.id} — ${run.findings.length} finding(s) across ${run.files} file(s) [${run.status}]`,
          payload: {
            reviewId: run.id, status: run.status, files: run.files,
            findings: run.findings.map((f) => ({ id: f.id, file: f.file, line: f.line, severity: f.severity, summary: f.summary })),
          },
        },
      );
      if (memoryId) linkBackgroundTaskMemory(workspaceRoot, task.id, memoryId);
    } catch { /* advisory — never break the review */ }
    const ok = run.status !== 'failed';
    const done = updateBackgroundTask(workspaceRoot, task.id, {
      status: ok ? 'completed' : 'failed',
      error: ok ? undefined : (run.summary || 'Review failed.'),
      result: { reviewId: run.id, findings: run.findings.length, files: run.files, status: run.status },
    });
    if (done) emitTaskEvent(ok ? 'completed' : 'failed', done);
    recordTelemetry({ name: TELEMETRY_EVENTS.review_completed, workspaceRoot, sessionKey, ok, durationMs: Date.now() - startedAt, props: { findings: run.findings.length, files: run.files } });
    return { ...run, taskId: task.id };
  };
  const reviewSnapshot = async (): Promise<{ run: ReviewRun | null; gate: ReturnType<typeof reviewGate>; diffHash: string; files: number }> => {
    const { diff, files } = await collectWorkingDiff();
    const diffHash = hashDiff(diff);
    let run = getLatestReview(workspaceRoot);
    if (run) { const staled = staleIfDiffChanged(run, diffHash); if (staled !== run) { saveReview(workspaceRoot, staled); run = staled; } }
    return { run, gate: reviewGate(run, diffHash), diffHash, files: files.length };
  };

  // §1 (workflow gaps) — "Request changes" on a plan launches a REAL background
  // plan-revision task: a write-capable agent (own internal session = the task's
  // transcript) rewrites the plan to address the feedback; its `update_plan` is
  // intercepted and the host writes the result into the USER's session plan,
  // snapshots a `revised` version, repaints the panel, and captures memory. The
  // task is created synchronously (so the handler returns it immediately) and the
  // turn runs async — visible in Background tasks with status/elapsed/transcript.
  type RevisedPlan = { items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed'; acceptance?: string }>; explanation?: string };
  const runPlanRevisionTask = (sessionKey: string, decision: PlanDecision, feedback: string): BackgroundTaskRecord => {
    const planBefore = readPlan(workspaceRoot, sessionKey);
    const task = createBackgroundTask(workspaceRoot, {
      kind: 'plan-revision', title: 'Revise plan — requested changes', sessionKey,
      requirementId: planBefore.requirementId, planId: decision.id, status: 'running',
    });
    const reviserKey = `internal:plan-revision:${task.id}`;
    const created = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: reviserKey } }) ?? task;
    emitTaskEvent('created', created);
    recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_started, workspaceRoot, sessionKey, taskKind: 'plan-revision' });

    void (async () => {
      const startedAt = Date.now();
      try {
        taskProgress(task.id, 'analyzing-feedback');
        const reviser = spawnTaskAgent(reviserKey, 'write');
        let revised: RevisedPlan | null = null;
        const cb = {
          onStatusUpdate: (text: string) => { if (text) taskProgress(task.id, 'working', text.slice(0, 80)); },
          onToolStart: (): void => {}, onToolEnd: (): void => {}, onAssistantDelta: (): void => {},
          onAssistantTurnStart: (): void => {}, onAssistantTurnEnd: (): void => {}, onReasoningDelta: (): void => {}, onUsageUpdate: (): void => {},
          onPlanUpdate: (items: RevisedPlan['items'], explanation?: string) => { revised = { items, explanation }; },
        } as never;
        // §plan-comments — the reviewer's per-step comments (open `plan`
        // annotations) ride into the revision so the agent addresses each one,
        // not just the top-level note. Advisory: never break the revision.
        const stepNotes = (() => {
          try {
            return listAnnotations(workspaceRoot, { targetKind: 'plan', sessionKey })
              .filter((n) => n.status !== 'resolved' && n.status !== 'rejected' && n.status !== 'ignored');
          } catch { return [] as AnnotationRecord[]; }
        })();
        const notesBlock = stepNotes.length
          ? `\n\nPer-step comments from the reviewer (address each):\n${stepNotes.map((n) => `- ${n.anchor?.block ?? 'plan'}${n.anchor?.selectedText ? ` (“${n.anchor.selectedText}”)` : ''}: ${n.body}`).join('\n')}`
          : '';
        const changesText = feedback || "Address the reviewer's per-step comments below.";
        const prompt = `The implementation plan below was NOT approved.\n\nRequested changes:\n${changesText}${notesBlock}\n\nCurrent plan:\n${formatPlan(planBefore)}\n\nRevise the plan to fully address the requested changes, then call \`update_plan\` with the corrected, ordered plan (each item { step, status }, at most one in_progress). Do not implement anything — only produce the revised plan.`;
        await (reviser as { runTurn(p: string, c: unknown): Promise<string> }).runTurn(prompt, cb);
        taskProgress(task.id, 'writing-plan');
        const result = revised as RevisedPlan | null;
        if (result && Array.isArray(result.items) && result.items.length > 0) {
          const next = updatePlan(workspaceRoot, { plan: result.items, explanation: result.explanation, requirementId: planBefore.requirementId }, sessionKey);
          // §plan-comments — the revision addressed them; resolve so they don't
          // re-inject on the next request (advisory).
          for (const n of stepNotes) { try { setAnnotationStatus(workspaceRoot, n.id, 'resolved'); } catch { /* advisory */ } }
          // Version history: snapshot the revised plan as a `revised` decision.
          const revDecision = recordPlanDecision(workspaceRoot, sessionKey, { verdict: 'revised', planSnapshot: next.items, explanation: next.explanation, requirementId: next.requirementId });
          // Repaint the USER's Plan panel with the revised plan (the feedback
          // returns to the same active session).
          send({ seq: ++portSeq, ts: Date.now(), sessionKey, event: { kind: 'plan-update', items: next.items.map((i) => ({ step: i.step, status: i.status, acceptance: i.acceptance })), explanation: next.explanation } });
          let memoryId: string | undefined;
          try {
            memoryId = (await emitAgentEvent(
              { mcpClient, sessionKey },
              {
                kind: 'agent_output',
                summary: `Plan revised (${revDecision.id}) addressing requested changes — ${next.items.length} item(s)`,
                payload: { planDecisionId: revDecision.id, sourceDecisionId: decision.id, verdict: 'revised', itemCount: next.items.length, feedback },
              },
            )) ?? undefined;
            if (memoryId) { linkPlanDecision(workspaceRoot, sessionKey, revDecision.id, memoryId); linkBackgroundTaskMemory(workspaceRoot, task.id, memoryId); }
          } catch { /* advisory */ }
          const done = updateBackgroundTask(workspaceRoot, task.id, { status: 'completed', result: { items: next.items.length, revisedDecisionId: revDecision.id } });
          if (done) emitTaskEvent('completed', done);
          recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_completed, workspaceRoot, sessionKey, ok: true, durationMs: Date.now() - startedAt, props: { items: next.items.length } });
        } else {
          const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: 'The revision produced no updated plan. Request changes again with more specific feedback.' });
          if (failed) emitTaskEvent('failed', failed);
          recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_completed, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt });
        }
      } catch (err) {
        const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
        if (failed) emitTaskEvent('failed', failed);
        recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_completed, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return created;
  };

  // GitHub / connector / Track-PR service layer — extracted to a cohesive
  // sibling module. host.ts assembles its runtime deps (workspace + the two
  // reassigned bindings it reads/writes) and folds the returned functions into
  // the HostContext below; the scheduler timers are cleared on shutdown.
  const githubTrackServices = buildGithubTrackServices({
    workspaceRoot, mcpClient, secretBridge, spawnTaskAgent, emitTaskEvent, taskProgress,
    getActiveAgent: () => activeAgent, setPrCache: (v) => { prCache = v; },
  });
  const {
    ghText, ghJson, githubApiBase, githubStaticToken, githubConnectorToken, connectorEnvToken,
    mcpConnectorClient, githubTokenJson, currentGitBranch, trackItemForBranch, readTrackPrStatus,
    githubGhValidationClient, githubTokenValidationClient, githubGhPermissionClient, githubTokenPermissionClient,
    validateGithubConnector, githubConnectorClient,
    indexConnectorMemory, runConnector, syncConnectorPermissions,
    createTrackDraftPr, importTrackIssuesFromGh, mergeCurrentTrackPr, submitTrackPrReview, fixCurrentTrackPrChecks,
    connectorSchedulerTimer, connectorSchedulerBootTimer, resetGhEnvCache,
  } = githubTrackServices;

  // ── Extracted-module context ────────────────────────────────────────────────
  // The query router (host/queries.ts) and its handler bodies used to live inline
  // here as a ~2400-line object literal of closures over the bindings above. That
  // was the god-file weight. It now lives in a cohesive sibling module that takes
  // this bag. Stable bindings pass by shorthand; the few that are REASSIGNED over
  // the process lifetime (the viewed agent, the global llm, the PR caches, the
  // terminal sequence) pass as live accessors so behavior is unchanged.
  // BROWSER metadata/dev-server host — live browsing is owned by the window's
  // WebContentsView manager and injected browser-control port. This host retains
  // UI-map extraction, stories/reports, and dev-server orchestration only; its
  // core session has an unavailable production backend and never starts Playwright.
  const devServers = createDevServerRegistry(workspaceRoot);
  const browser = createBrowserHost(workspaceRoot, devServers);

  const allBrainServerIds = (candidate: ReturnType<typeof loadConfig>): string[] =>
    Object.entries(candidate.servers ?? {})
      .filter(([id, server]) => isBrainRouterLearningProfile(id, server))
      .map(([id]) => id);
  const brainServerIds = (candidate: ReturnType<typeof loadConfig>): string[] => {
    const selected = new Set(selectMcpServerIds(candidate.servers ?? {}, candidate.activeServer));
    return allBrainServerIds(candidate).filter((id) => selected.has(id));
  };
  let core!: ReturnType<typeof createHostCore>;
  const rebindActiveAccountOrg = async (
    next: ReturnType<typeof loadConfig>,
    options: { forceIdentity?: boolean } = {},
  ): Promise<boolean> => {
    const targetAccount = (next as { cli?: { account?: { orgId?: unknown } } }).cli?.account;
    const targetOrgId = typeof targetAccount?.orgId === 'string' ? targetAccount.orgId.trim() : '';
    const activeOrgId = activeAgent.learnedTenant?.orgId ?? null;
    const identityAlreadyVerified = learningBinding.source === 'server'
      && learningBinding.enabled
      && learningBinding.tenant.orgId === targetOrgId;
    if (
      !options.forceIdentity
      && targetOrgId
      && boundBrainOrgId === targetOrgId
      && activeOrgId === targetOrgId
      && identityAlreadyVerified
    ) {
      const prepared = withAccountOrgId(loadConfig(), targetOrgId);
      if (prepared.changed) {
        saveConfig(prepared.next as ReturnType<typeof loadConfig>);
        _resetCliKnobsCache();
        config = prepared.next as ReturnType<typeof loadConfig>;
      }
      return prepared.changed;
    }
    await core.rebindTenant(async (sessionKey) => {
      // Boot connection and its session registration must settle before we
      // replace transport state, otherwise its late continuation could restore
      // the previous org after this switch completes.
      await mcpReady;
      const previous = loadConfig();
      // Every live workspace host receives the org switch. Rebase the tenant
      // patch on the latest config at the actual drain boundary so a slower
      // host cannot overwrite an unrelated setting saved by a faster host.
      const prepared = withAccountOrgId(previous, targetOrgId);
      const reboundConfig = prepared.next as ReturnType<typeof loadConfig>;
      const previousBrainIds = allBrainServerIds(previous);
      const nextBrainIds = brainServerIds(reboundConfig);
      mcpClient.stopReconnectSupervisor();
      try {
        await endBrainSession(mcpClient);
        for (const id of new Set([...previousBrainIds, ...nextBrainIds])) {
          try { await mcpClient.disconnectOne(id); } catch { /* client is already removed before index refresh */ }
        }

        if (prepared.changed) saveConfig(reboundConfig);
        _resetCliKnobsCache();
        config = reboundConfig;
        accountModelCatalog = null;
        accountModelCatalogAt = 0;
        modelsCacheByKey.delete('');
        // From this point onward every saved/reconnectable BrainRouter profile
        // carries targetOrgId. A failed network connection is offline, not an
        // old-tenant connection, so the replacement Agent remains safe.
        boundBrainOrgId = targetOrgId;
        learningBinding = initialDesktopLearningBinding(desktopLearningIdentityConfig(reboundConfig));

        for (const id of nextBrainIds) {
          const server = reboundConfig.servers?.[id];
          if (!server) continue;
          try {
            // Connection failures are represented as a failed pool status and
            // do not throw. An unexpected index-refresh error is treated the
            // same way: remove that client so the replacement stays offline
            // instead of retaining an ambiguous central tenant.
            await mcpClient.connectOne(id, server, loadGlobalLlm(), 5_000);
          } catch {
            try { await mcpClient.disconnectOne(id); } catch { /* offline is the fail-closed state */ }
          }
        }
        if (nextBrainIds.length) await sessionMessaging?.refreshRemote();
        await resolveLearningIdentity(reboundConfig);
      } catch (error) {
        // The only expected throw above is persistence (connectOne records
        // network failures in status). Rebind transport to whichever config
        // actually survived, then let hostCore install its fallback Agent and
        // report the failed requested switch. This makes rollback operational,
        // not merely non-leaking.
        const surviving = loadConfig();
        const survivingAccount = (surviving as { cli?: { account?: { orgId?: unknown } } }).cli?.account;
        const survivingOrgId = typeof survivingAccount?.orgId === 'string'
          ? survivingAccount.orgId.trim()
          : '';
        const repaired = withAccountOrgId(surviving, survivingOrgId).next as ReturnType<typeof loadConfig>;
        const survivingBrainIds = brainServerIds(repaired);
        for (const id of new Set([...previousBrainIds, ...nextBrainIds, ...survivingBrainIds])) {
          try { await mcpClient.disconnectOne(id); } catch { /* continue to the repaired profile */ }
        }
        config = surviving;
        boundBrainOrgId = survivingOrgId;
        for (const id of survivingBrainIds) {
          const server = repaired.servers?.[id];
          if (!server) continue;
          try { await mcpClient.connectOne(id, server, loadGlobalLlm(), 5_000); } catch {
            try { await mcpClient.disconnectOne(id); } catch { /* offline remains tenant-safe */ }
          }
        }
        if (survivingBrainIds.length) await sessionMessaging?.refreshRemote();
        await resolveLearningIdentity(repaired);
        throw error;
      } finally {
        mcpClient.startReconnectSupervisor();
      }
      // `spawnAgent` reads only the verified custom-channel binding. It runs
      // after the matching transport is installed (or with learning disabled
      // when identity cannot be proven).
      return spawnAgent(sessionKey);
    });
    return true;
  };

  sessionMessaging = new DesktopSessionMessaging({
    workspaceRoot,
    mcp: mcpClient,
    getActiveAgent: () => activeAgent,
    deliverPeer: (message, sender) => core.deliverPeerMessage(message, sender),
    confirmHeld: (record) => requestDesktopHeldConfirmation(broker, record, {
      emitRequest: emitPortFor,
      emitResolved: emitInteractionResolvedFor,
    }),
    onNotice: (sessionKey, message) => send({
      seq: ++portSeq,
      ts: Date.now(),
      sessionKey,
      event: { kind: 'notice', level: 'warn', message },
    }),
  });

  const ctx: HostContext = {
    browser,
    devServers,
    workspaceRoot, wsGit, fileListCache, listWorkspaceFilesCached, send,
    computerUseBridge, secretBridge, config,
    getLlm: () => llm, setLlm: (next) => { llm = next; },
    mcpClient, sessionMessaging, callBrainAtlas, broker, emitPortFor, agent,
    getActiveAgent: () => activeAgent,
    loadGlobalLlm, llmForSession, resolveProviderLlm, refreshAccountModelCatalog, peekAccountModelCatalog, syncActiveSessionLlm,
    revokeReviewedExecutionAuthority: (scope) => core.revokeReviewedExecutionAuthority(scope),
    rebindActiveAccountOrg, activeTenantBindingError, humanCorrectionIngress,
    spawnAgent, spawnReviewer, spawnTaskAgent, activeMemorySessionKey,
    lifecycleActionFor, emitRecordEvent, taskEventView, emitTaskEvent, taskProgress,
    verifyTitle, observeVerificationEvent, goalStrikes,
    captureRequirementNote, captureAnnotationNote, captureAnnotationExportNote, captureArtifactNote,
    ptyRegistry, hostedAgents, fanoutManager, remoteWorktrees, mobileRelay, remoteAccess, egressTunnel, modelsCacheByKey,
    getPrCache: () => prCache, setPrCache: (v) => { prCache = v; },
    getPrStatusMapCache: () => prStatusMapCache, setPrStatusMapCache: (v) => { prStatusMapCache = v; },
    readTranscriptCached, isoNow, collectWorkingDiff,
    runReview, runReviewTask, reviewSnapshot, runPlanRevisionTask,
    resetGhEnvCache,
    ghText, ghJson, githubApiBase, githubStaticToken, githubConnectorToken, connectorEnvToken,
    mcpConnectorClient, githubTokenJson, currentGitBranch, trackItemForBranch, readTrackPrStatus,
    githubGhValidationClient, githubTokenValidationClient, githubGhPermissionClient, githubTokenPermissionClient,
    validateGithubConnector, githubConnectorClient,
    indexConnectorMemory, runConnector, syncConnectorPermissions,
    createTrackDraftPr, importTrackIssuesFromGh, mergeCurrentTrackPr, submitTrackPrReview, fixCurrentTrackPrChecks,
    SEV_MAP,
  };

  core = createHostCore({
    agent,
    spawnAgent,
    onActiveAgentChange: (a) => {
      activeAgent = a as unknown as typeof agent;
      void sessionMessaging?.activate(activeAgent);
    },
    onSessionActivityChange: (sessionKey, state) => sessionMessaging?.setActivity(sessionKey, state),
    onSessionTitle: (sessionKey, title, source) => sessionMessaging?.setTitle(sessionKey, title, source),
    onPeerSteerApplied: (sessionKey, steering) => sessionMessaging?.onPeerApplied(sessionKey, steering.id),
    onPeerSteerExpired: (sessionKey, steering) => sessionMessaging?.onPeerExpired(sessionKey, steering.id),
    send: send as never,
    // Verification scoping — observe each turn's tool stream to track its
    // build/test/lint commands as durable `verification` background tasks.
    observeTurnEvent: observeVerificationEvent,
    broker,
    loadTranscript: (key) => readTranscriptCached(key), // FULL — agent continuation only
    transcriptExists: (key) => transcriptExists(workspaceRoot, key), // OOM-safe cheap resume count
    persistModel: (model) => {
      // Both heads read this file — a model picked in the desktop settings is
      // the CLI's model on its next launch, and vice versa.
      const fresh = loadConfig();
      fresh.llm = { ...(fresh.llm ?? llm), model };
      saveConfig(fresh);
      llm = fresh.llm;
      modelsCacheByKey.delete('');
    },
    // Item 10 — per-session model: read on (re)spawn so a chat keeps its model;
    // written when set-model arrives with persist:false ("this chat only").
    getSessionModel: (sessionKey) => getSessionRuntime(workspaceRoot, sessionKey).model || undefined,
    setSessionModel: (sessionKey, model) => { setSessionRuntime(workspaceRoot, sessionKey, { model }); },
    clearSessionModel: (sessionKey) => { setSessionRuntime(workspaceRoot, sessionKey, { model: '' }); },
    // Per-session provider+model: write the full runtime override (no secret) so a
    // chat can run a different provider than the global default.
    setSessionLlm: (sessionKey, patch) => { setSessionRuntime(workspaceRoot, sessionKey, patch); },
    // Resolve a saved connection (by name) to a full LLM config — used to rebuild
    // the active agent when a cross-provider model is picked.
    resolveProviderLlm: (providerName, model) => resolveProviderLlm(providerName, model),
    // Full per-session LLM (provider/model/endpoint + resolved key) for the active
    // chat — used to rebuild the agent on a session switch.
    resolveSessionLlm: (sessionKey) => llmForSession(sessionKey),
    validateTurn: async (sessionKey) => {
      const tenantError = activeTenantBindingError();
      // Identity discovery may finish after a turn begins. The Agent is already
      // learning-disabled in that boot state, so ordinary model work remains
      // usable while all ADR-032 retrieval/correction/checkpoint paths stay off.
      // A verified binding mismatch still blocks the complete turn boundary.
      if (tenantError && learningBinding.source !== 'unresolved-authenticated-profile') return tenantError;
      const runtime = llmForSession(sessionKey);
      const sessionEffort = getSessionMode(workspaceRoot, sessionKey).effort;
      const configuredEffort = (loadConfig() as { cli?: { effort?: unknown } }).cli?.effort;
      const preferenceEffort = readPreferences(workspaceRoot).effort;
      const persistedEffort = sessionEffort ?? configuredEffort ?? preferenceEffort;
      if (typeof persistedEffort === 'string' && !normalizeEffort(persistedEffort)) {
        return `The saved reasoning effort “${persistedEffort}” is no longer supported. Choose a current effort before sending.`;
      }
      const effort = String(resolveActiveMode(workspaceRoot, sessionKey).effort ?? '');
      if (runtime.provider !== 'brainrouter') return null;
      const catalog = await refreshAccountModelCatalog(true);
      if (!catalog.signedIn) return 'Sign in to BrainRouter or choose a Personal/BYOK model before sending.';
      const policy = catalog.models.find((entry) => entry.id === runtime.model && entry.enabled);
      if (!policy) return `The managed model “${runtime.model}” is no longer available. Choose another model before sending.`;
      if (policy.reasoning && !policy.reasoning.allowed.some((entry) => entry.id === effort)) {
        return `${policy.label} does not allow the “${effort}” effort. Choose one of its available efforts before sending.`;
      }
      return null;
    },
    // GLOBAL default from a named connection + a chosen model (config.json).
    persistProviderModel: (providerName, model) => {
      const fresh = loadConfig();
      const p = fresh.providers?.[providerName];
      if (!p) return;
      fresh.llm = { provider: p.provider, apiKey: p.apiKey, model: model || p.model, endpoint: p.endpoint };
      saveConfig(fresh);
      llm = fresh.llm;
      modelsCacheByKey.delete('');
    },
    queries: buildQueries(ctx),
    onShutdown: async () => {
      clearInterval(connectorSchedulerTimer);
      clearTimeout(connectorSchedulerBootTimer);
      stopWorkspaceWatcher();
      mobileRelay.stop();
      egressTunnel.stop();
      fanoutManager.dispose();
      hostedAgents.dispose();
      ptyRegistry.dispose();
      browser.dispose();
      browserControlBridge?.dispose();
      devServers.disposeAll();
      if (sessionMessaging) await sessionMessaging.close();
      else await endBrainSession(mcpClient);
      await mcpClient.close?.();
      process.exit(0);
    },
  });

  // Local registration is independent of Brain connectivity and starts as soon
  // as the Agent/core pair exists. The background MCP result only refreshes the
  // remote registration and immediately polls the durable inbox.
  void sessionMessaging.start(activeAgent);
  void mcpReady.then(() => sessionMessaging?.refreshRemote()).catch(() => {});

  // Apply the background boot result at hostCore's serialized idle boundary.
  // If a turn is already running, bindLearning waits for its finalization and
  // mutates only learning fields; it never replaces the Agent or its history.
  void mcpReady
    .then((resolved) => core.bindLearning({
      userId: resolved.tenant.userId,
      orgId: resolved.tenant.orgId ?? null,
    }, resolved.enabled))
    .catch(() => { /* shutting down or an older Agent without the binding seam */ });

  if (port) port.on('message', (e) => {
    if (computerUseBridge?.handleMessage(e.data)) return;
    if (secretBridge?.handleMessage(e.data)) return;
    if (browserControlBridge?.handleMessage(e.data)) return;
    void core.handle(e.data);
  });

  // DESK-5d/5u — boot announcement. Emitted AFTER the message listener is
  // attached, so a renderer that waits for it can safely start querying. The
  // renderer treats a fresh `session-changed` as "reset surfaces".
  //
  // DESK-5u — open on a FRESH NEW CHAT (the agent's randomUUID session), not
  // a restored previous one. Every past transcript is still on disk and listed
  // in the sidebar, so nothing is lost — the user picks one to resume. (This
  // reverts the 5t boot-resume: "open on a new chat" is the wanted behavior.)
  send({
    seq: 0, ts: Date.now(), sessionKey: activeAgent.sessionKey,
    event: { kind: 'session-changed', sessionKey: activeAgent.sessionKey, loadedMessages: 0, model: activeAgent.getModel?.() ?? llm.model },
  });
}

main().catch((err) => {
  console.error('[brainrouter-desktop host] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
