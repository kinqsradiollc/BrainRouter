/**
 * host/queries — the desktop host's read/mutation query router.
 *
 * This is the ~2400-line `queries` object literal that used to live inline in
 * host.ts's `main()`. It was the bulk of the god file. The handler BODIES are
 * unchanged (byte-identical) except for a small, mechanical substitution: the
 * handful of `main()`-local bindings that are REASSIGNED over the process
 * lifetime — the viewed agent, the global `llm`, the two PR caches, the terminal
 * sequence — are read/written through live accessors on {@link HostContext}
 * instead of captured values, so behavior is exactly as before.
 *
 * host.ts assembles the {@link HostContext} and folds `buildQueries(ctx)` into
 * the `createHostCore({ queries })` map.
 */
import { createBrokerPort, createHostCore, type AgentLike } from '../hostCore.js';
import { mergeGithubCliEnv, normalizeGithubCliError } from '../ghCli.js';
import { shellQuoteArg } from '../shellQuote.js';
// host/helpers — pure, closure-free helpers (config scrubbing, Track↔GitHub
// normalization, computer-use/secret bridges, endpoint model probing, transcript
// row reconstruction) extracted verbatim from this file.
import {
  scrubCliSecrets,
  normalizeTrackGithubRepos,
  syncLegacyTrackGithubFields,
  githubIntegrationSnapshot,
  TERM_BUF_CAP,
  fetchEndpointModels,
  matchingDefaultProvider,
  reconstructTranscriptRows,
  annotateStale,
  annotationFilterFromArgs,
  annotationAnchorFromArgs,
  artifactFilterFromArgs,
  withSessionScope,
  workerEventsToRows,
  git,
  sessionRows,
  type TrackGithubConfig,
  type TermSession,
} from './helpers.js';
import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InteractionBroker,
  type AgentEvent,
  type AgentImage,
  type ComputerUseAction,
  type ComputerUseActionResult,
  type ComputerUsePort,
  type RecordLifecycleAction,
} from '@kinqs/brainrouter-agent-protocol';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { callOpenAI } from '@kinqs/brainrouter-core/agent';
import {
  CLI_CONFIG_SCHEMA,
  findConfigSchemaField,
  loadConfig,
  saveConfig,
  getCliKnobs,
  resolveCliKnobs,
  _resetCliKnobsCache,
  applyRuleEdit,
  setConfigValueAtPath,
  type LLMConfig,
} from '@kinqs/brainrouter-core/config';
import { aggregateCatalog, buildModelRegistry, getRouterPolicy } from '@kinqs/brainrouter-core/router';
import {
  createRuntimeRunnerClient,
  listRuntimePreviewPorts,
  registerRuntimePreviewPort,
  removeRuntimePreviewPort,
  resolveRuntimePreviewReservations,
  listRuntimeRecords,
  removeRuntimeRecord,
  listArchives,
  resumeFromArchive,
  pruneArchives,
  type RuntimeRunnerClient,
} from '@kinqs/brainrouter-core/runtime';
// 0.4.15 — named providers + per-sub-agent model routing (pure transforms).
import { setProvider, removeProvider, setAgentModel, normalizeProviderModels, PROVIDER_CATALOG } from '@kinqs/brainrouter-core/provider';
import { childSessionKey } from '@kinqs/brainrouter-core/mcp';
import {
  listTranscripts,
  loadTranscript,
  readTranscriptTail,
  transcriptSizeBytes,
  deleteSession,
  forkSession,
  appendTranscriptEntry,
  rewindTranscript,
  readSessionMetaAll,
  getSessionMeta,
  setSessionMeta,
  removeSessionMeta,
  listSessionGroups,
  type SessionMeta,
  getSessionMode,
  setSessionMode,
  resolveActiveMode,
  buildRecap,
  readPreferences,
  writePreferences,
  searchTranscript,
  exportTranscriptMarkdown,
  exportTranscriptJson,
  exportFileName,
  listChapters,
} from '@kinqs/brainrouter-core/session';
import { readUsageHistory, totalUsage } from '@kinqs/brainrouter-core/usage';
import { readWorkspaceEntry, isWorkspaceDirectory, statWorkspaceEntry, writeWorkspaceEntry } from '../fsRead.js';
import { saveWorkflowGraph, loadWorkflowGraph, listWorkflowGraphs, deleteWorkflowGraph } from '@kinqs/brainrouter-core/workflow';
import type { WorkflowGraph } from '@kinqs/brainrouter-core/workflow';
import { writeThreadKey, buildGroundingBlock, pickLocalGrounding } from '@kinqs/brainrouter-core/write';
import { WorkspaceFileListCache, type WorkspaceFileListResult } from '../workspaceFileListCache.js';
import { loadSchedules, addSchedule, removeSchedule, setScheduleEnabled } from '@kinqs/brainrouter-core/schedule';
import { parseCron, nextCronFire } from '@kinqs/brainrouter-core/schedule';
import { parseReviewFindings, REVIEW_OUTPUT_CONTRACT, stripReasoning } from '@kinqs/brainrouter-core/review';
import { isFindingStatus } from '@kinqs/brainrouter-core/review';
import { getLatestReview, updateReviewFinding } from '@kinqs/brainrouter-core/review';
import { getStateDir } from '@kinqs/brainrouter-core/storage';
import { collectRunningTasks } from '@kinqs/brainrouter-core/background';
import { killBackgroundShell } from '@kinqs/brainrouter-core/exec';
import { contextWindowForBudget } from '@kinqs/brainrouter-core/context';
// DESK-4c — the command/settings surfaces reuse the CLI's own modules so the
// desktop never drifts from the terminal: same catalog, same preferences
// file, same hooks store, same transcript tooling.
import { SLASH_COMMANDS, HELP_CATEGORIES } from '@kinqs/brainrouter-core/command';
import { validateCatalogParity } from '@kinqs/brainrouter-core/command';
import { readHooks, setHookEnabled } from '@kinqs/brainrouter-core/hooks';
import { buildUsageBreakdown } from '@kinqs/brainrouter-core/util';
import { scanSuggestedTasks, listAutomationRules, setAutomationRuleEnabled } from '@kinqs/brainrouter-core/triggers';
import { startTriggerServe, stopTriggerServe, triggerServeStatus } from './triggerServe.js';
import { startRouterServe, stopRouterServe, routerServeStatus } from './routerServe.js';
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
import { listExtensions } from '@kinqs/brainrouter-core/extension';
import { isExtensionEnabled, setExtensionEnabled } from '@kinqs/brainrouter-core/extension';
import { extensionContributionSummary } from '@kinqs/brainrouter-core/extension';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace } from '@kinqs/brainrouter-core/workspace';
import { readPlan, formatPlan, seedPlanFromRequirement, updatePlan } from '@kinqs/brainrouter-core/task';
// DURABLE BACKGROUND TASKS (0.4.15 workflow gaps) — plan-revision + review work
// runs as visible, file-backed tasks (shared with the CLI store) so progress +
// transcript survive workspace/session switches and host reload.
import {
  createBackgroundTask,
  updateBackgroundTask,
  listBackgroundTasks,
  getBackgroundTask,
  currentPhase,
} from '@kinqs/brainrouter-core/background';
import { collectDurableRunningTasks } from '@kinqs/brainrouter-core/background';
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
import { readPlanHistory, recordPlanDecision, linkPlanDecision, type PlanVerdict } from '@kinqs/brainrouter-core/task';
import { emitAgentEvent } from '@kinqs/brainrouter-core/memory';
// REQUIREMENT-RECORDS — Requirement Records store (shared with the CLI).
import {
  listRequirements,
  getRequirement,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  type RequirementPatch,
} from '@kinqs/brainrouter-core/requirement';
import {
  buildBaseGraph,
  saveAtlasGraph,
  readAtlasGraph,
  atlasGraphStats,
  atlasWorkspaceTag,
  enrichAtlasGraph,
  carryForwardSummaries,
  extractAtlasJson,
  type AtlasLlmCaller,
} from '@kinqs/brainrouter-core/atlas';
import { syncRequirementPlanTrack } from '@kinqs/brainrouter-core/requirement';
import {
  ensureProject,
  getProject,
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
  migrateTrackGithubToConnector,
  setGithubSyncTarget,
} from '@kinqs/brainrouter-core/track';
import { scanGitCommitsForTrack } from '@kinqs/brainrouter-core/track';
import { readGitTrackContext, startGitWorkForTrackItem } from '@kinqs/brainrouter-core/track';
import { listConnectorCatalog } from '@kinqs/brainrouter-core/connectors';
import {
  createConnector,
  deleteConnector,
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
import { countConnectorDocuments, searchConnectorDocuments } from '@kinqs/brainrouter-core/connectors';
import { countConnectorPermissions, listConnectorPermissions } from '@kinqs/brainrouter-core/connectors';
import { retrieveConnectorSlimDocuments } from '@kinqs/brainrouter-core/connectors';
// PLUGIN-MARKETPLACE P4-desktop — the Marketplace UI's read/mutation surface.
// Delegates to the shared core plugin runtime (fs/git in the host, never the
// renderer). Search/install/enable/remove/consent all live in pluginBridge.ts.
import {
  listInstalledPlugins,
  searchRegistryPlugins,
  pluginConsentSummary,
  installPluginFromRegistry,
  installPluginFromSource,
  setPluginEnabledBridge,
  setPluginConsentBridge,
  removePluginBridge,
} from './pluginBridge.js';
import type { WorkItemType, SprintState, CodeLink, AutomationTrigger, AutomationAction, ProjectRole, ConnectorFlow, ConnectorRecord, ConnectorSource } from '@kinqs/brainrouter-types';

import { isRequirementStatus, isRequirementPriority } from '@kinqs/brainrouter-types';
// ANNOTATION-RECORDS (0.4.15) — durable feedback records store + markdown
// export (shared with the CLI). Thin wrappers below keep all business logic in
// the CLI store; the desktop panel only reads/mutates through these endpoints.
import {
  listAnnotations,
  getAnnotation,
  createAnnotation,
  setStatus as setAnnotationStatus,
  addComment as addAnnotationComment,
  type CreateAnnotationInput,
} from '@kinqs/brainrouter-core/annotation';
import { annotationsToMarkdown } from '@kinqs/brainrouter-core/annotation';
import { isAnnotationStatus, isAnnotationTargetKind, isAnnotationSeverity } from '@kinqs/brainrouter-types';
// ARTIFACT-RECORDS (0.4.15) — durable Artifact Records store (shared with the
// CLI). Thin wrappers below keep all business logic in the CLI store; the
// desktop panel only reads/mutates/previews through these endpoints.
import {
  listArtifacts,
  createArtifact,
  updateArtifact,
  getArtifact,
  revertArtifact,
  type CreateArtifactInput,
  type ArtifactPatch,
} from '@kinqs/brainrouter-core/artifact';
import { isArtifactKind, isArtifactStatus, isArtifactFormat } from '@kinqs/brainrouter-types';
import { listWorkers, readWorkerSummary, readWorkerTranscript, readWorkerMeta } from '@kinqs/brainrouter-core/worker';
import { listSessions } from '@kinqs/brainrouter-core/orchestration';
import { localToolSpecsFromExecutors, isProtectedCoreTool } from '@kinqs/brainrouter-core/tool';
import { readRun } from '@kinqs/brainrouter-core/workflow';
import { desktopSessionModePatchFromArgs, mergeSessionModePrefs } from '../sessionModeBridge.js';
import type { HostContext, TrackPrView } from './context.js';
import type { QueryHandler } from '../hostCore.js';

export function buildQueries(ctx: HostContext): Record<string, QueryHandler> {
  const {
    workspaceRoot,
    wsGit,
    fileListCache,
    listWorkspaceFilesCached,
    send,
    config,
    mcpClient,
    callBrainAtlas,
    agent,
    llmForSession,
    syncActiveSessionLlm,
    spawnTaskAgent,
    taskEventView,
    emitTaskEvent,
    taskProgress,
    goalStrikes,
    captureRequirementNote,
    captureAnnotationNote,
    captureAnnotationExportNote,
    captureArtifactNote,
    terms,
    modelsCacheByKey,
    isoNow,
    runReview,
    runReviewTask,
    reviewSnapshot,
    runPlanRevisionTask,
    ghText,
    ghJson,
    githubConnectorToken,
    githubTokenJson,
    readTrackPrStatus,
    validateGithubConnector,
    indexConnectorMemory,
    runConnector,
    syncConnectorPermissions,
    createTrackDraftPr,
    importTrackIssuesFromGh,
    mergeCurrentTrackPr,
    submitTrackPrReview,
    fixCurrentTrackPrChecks,
    getActiveAgent,
    getLlm,
    setLlm,
    getPrCache,
    setPrCache,
    getPrStatusMapCache,
    setPrStatusMapCache,
    nextTermSeq,
    resetGhEnvCache,
  } = ctx;
  let runtimeRunnerClient: RuntimeRunnerClient | null = null;
  let runtimeRunnerRemoteUrl = '';
  const getRuntimeRunnerClient = () => {
    const remoteUrl = getCliKnobs().runtime.remoteUrl;
    if (!runtimeRunnerClient || remoteUrl !== runtimeRunnerRemoteUrl) {
      runtimeRunnerRemoteUrl = remoteUrl;
      runtimeRunnerClient = createRuntimeRunnerClient({
        workspaceRoot,
        remoteUrl,
        executeTurn: async (turn) => getActiveAgent().runTurn(turn.prompt, {
          onStatusUpdate: () => {},
          onToolStart: () => {},
          onToolEnd: () => {},
        }, { hiddenPrompt: turn.hidden === true }),
      });
    }
    return runtimeRunnerClient;
  };
  return {
      // Read-only surfaces — same pure modules the TUI commands use.
      // DESK-6m — sidebar sessions merged with their UI meta (title override,
      // pinned/archived/status/group) and sorted pinned-first; the renderer's
      // per-chat ⋮ menu reads/writes this meta.
      'list-sessions': () => {
        const meta = readSessionMetaAll(workspaceRoot);
        const rows = sessionRows(workspaceRoot, 80).map((s) => {
          const m = meta[s.sessionKey] ?? {};
          return {
            ...s,
            firstUserMessage: m.title || s.firstUserMessage, // title overrides the snippet
            pinned: !!m.pinned, archived: !!m.archived, status: m.status ?? 'active', group: m.group ?? null,
            forkedFrom: m.forkedFrom ?? null, // DESK-6u — lineage for the fork icon + back-link
            branch: m.branch ?? null, // §session-pr — branch this session ran on, for PR-status matching
          };
        });
        // pinned first, then the store's recency order (sessionRows already sorts).
        return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      },
      // DESK-5d — another project's chat history, for the sidebar's expanded
      // project folders. Read-only transcript summaries; the trust gate still
      // guards SWITCHING into the workspace.
      'workspace-sessions': (args) => {
        const root = typeof args.root === 'string' ? args.root : '';
        const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit ?? 80);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(120, Math.floor(rawLimit))) : 80;
        if (!root || !fs.existsSync(root)) return { rows: [], error: 'Workspace is not available.' };
        try {
          const rows = sessionRows(root, limit);
          return { rows, truncated: rows.length >= limit };
        } catch (err) {
          return { rows: [], error: err instanceof Error ? err.message : String(err) };
        }
      },
      'runtime-runner-info': () => {
        const client = getRuntimeRunnerClient();
        return { mode: client.mode, remoteUrl: runtimeRunnerRemoteUrl || null };
      },
      'runtime-runner-status': async (args) => {
        const runtimeId = typeof args.runtimeId === 'string' ? args.runtimeId.trim() : '';
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey.trim() : '';
        if (!runtimeId || !sessionKey) return { error: 'runtimeId and sessionKey are required.' };
        return getRuntimeRunnerClient().status({ runtimeId, sessionKey });
      },
      'runtime-previews-list': () => ({
        reservations: resolveRuntimePreviewReservations(),
        previews: listRuntimePreviewPorts(workspaceRoot),
      }),
      'runtime-preview-register': (args) => {
        const runtimeId = typeof args.runtimeId === 'string' ? args.runtimeId.trim() : '';
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const port = typeof args.port === 'number' ? args.port : undefined;
        if (!runtimeId || !name) return { ok: false, error: 'runtimeId and name are required.' };
        try {
          return { ok: true, preview: registerRuntimePreviewPort(workspaceRoot, { runtimeId, name, port }) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      'runtime-preview-remove': (args) => ({
        ok: removeRuntimePreviewPort(
          workspaceRoot,
          typeof args.runtimeId === 'string' ? args.runtimeId : '',
          typeof args.name === 'string' ? args.name : '',
        ),
      }),
      // CONNECTORS — Onyx-like connector lifecycle foundation. These wrappers
      // expose the core catalog/store to the renderer without making Track Sync
      // pretend to be the general connector abstraction.
      'connectors-catalog': () => ({ catalog: listConnectorCatalog() }),
      'connectors-list': (args) => {
        const source = typeof args.source === 'string' ? args.source as ConnectorSource : undefined;
        const status = typeof args.status === 'string' ? args.status as never : undefined;
        return { connectors: listConnectors(workspaceRoot, { source, status }) };
      },
      'connector-detail': (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        const connector = id ? getConnector(workspaceRoot, id) : undefined;
        return connector ? {
          connector,
          runs: listConnectorRuns(workspaceRoot, id),
          documents: searchConnectorDocuments(workspaceRoot, { connectorId: id, limit: 20 }),
          permissions: listConnectorPermissions(workspaceRoot, { connectorId: id }).slice(0, 50),
        } : { connector: null, runs: [], documents: [], permissions: [] };
      },
      'connector-documents': (args) => searchConnectorDocuments(workspaceRoot, {
        connectorId: typeof args.connectorId === 'string' ? args.connectorId : undefined,
        repository: typeof args.repository === 'string' ? args.repository : undefined,
        kind: typeof args.kind === 'string' ? args.kind as never : undefined,
        query: typeof args.query === 'string' ? args.query : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }),
      'connector-slim-documents': (args) => retrieveConnectorSlimDocuments(workspaceRoot, {
        connectorId: typeof args.connectorId === 'string' ? args.connectorId : undefined,
        repository: typeof args.repository === 'string' ? args.repository : undefined,
        kind: typeof args.kind === 'string' ? args.kind as never : undefined,
        query: typeof args.query === 'string' ? args.query : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        maxSnippetChars: typeof args.maxSnippetChars === 'number' ? args.maxSnippetChars : undefined,
      }),
      'connector-permissions': (args) => listConnectorPermissions(workspaceRoot, {
        connectorId: typeof args.connectorId === 'string' ? args.connectorId : undefined,
        principalId: typeof args.principalId === 'string' ? args.principalId : undefined,
        repository: typeof args.repository === 'string' ? args.repository : undefined,
      }),
      'action:connector-create': (args) => {
        try {
          const connector = createConnector(workspaceRoot, {
            source: args.source as ConnectorSource,
            name: typeof args.name === 'string' ? args.name : '',
            description: typeof args.description === 'string' ? args.description : undefined,
            config: args.config && typeof args.config === 'object' && !Array.isArray(args.config) ? args.config as never : undefined,
            credential: args.credential && typeof args.credential === 'object' && !Array.isArray(args.credential) ? args.credential as never : undefined,
            flows: Array.isArray(args.flows) ? args.flows as ConnectorFlow[] : undefined,
          });
          return { ok: true, connector };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      'action:connector-update': (args) => {
        try {
          const id = typeof args.id === 'string' ? args.id : '';
          const patch = args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch as never : {};
          const connector = id ? updateConnector(workspaceRoot, id, patch) : undefined;
          return connector ? { ok: true, connector } : { ok: false, error: 'Connector not found.' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      'action:connector-delete': (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        return { ok: id ? deleteConnector(workspaceRoot, id) : false };
      },
      'action:connector-export-definitions': (args) => {
        try {
          const connectorIds = Array.isArray(args.connectorIds) ? args.connectorIds.filter((id): id is string => typeof id === 'string') : undefined;
          const bundle = exportConnectorDefinitions(workspaceRoot, { connectorIds });
          return { ok: true, bundle, json: JSON.stringify(bundle, null, 2) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      'action:connector-import-definitions': (args) => {
        try {
          const input = typeof args.json === 'string' ? args.json : args.bundle;
          if (!input) return { ok: false, error: 'Connector definition JSON is required.' };
          const connectors = importConnectorDefinitions(workspaceRoot, input as never);
          return { ok: true, connectors };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      // PLUGIN-MARKETPLACE P4-desktop — the Marketplace panel's endpoints. Reads
      // (list installed / search registry / consent summary) plus the mutating
      // install / enable / disable / remove / trust actions, all delegating to
      // the shared core plugin runtime through pluginBridge.ts.
      'plugin-list': async () => {
        try {
          return await listInstalledPlugins(workspaceRoot);
        } catch (err) {
          return { plugins: [], skippedForSafeMode: false, errors: [err instanceof Error ? err.message : String(err)] };
        }
      },
      'plugin-search': async (args) => {
        // Registry unreachable is a SOFT condition: search is degraded, but
        // installed plugins keep working. Surface a plain-language notice
        // instead of a raw transport error like "HTTP 404".
        const friendly = (raw: string): string => (
          /HTTP \d+|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(raw)
            ? `Community registry unreachable (${raw.replace(/^registry fetch failed:\s*/i, '')}). Installed plugins are unaffected — set a custom registry under Marketplace → Scope & sources.`
            : raw
        );
        try {
          const res = await searchRegistryPlugins(typeof args.query === 'string' ? args.query : '', {
            category: typeof args.category === 'string' && args.category ? args.category : undefined,
            tag: typeof args.tag === 'string' && args.tag ? args.tag : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
          });
          if (!res.ok) return { ok: false, hits: [], error: friendly(res.error) };
          return { ok: true, hits: res.hits, fromCache: res.fromCache };
        } catch (err) {
          return { ok: false, hits: [], error: friendly(err instanceof Error ? err.message : String(err)) };
        }
      },
      'plugin-consent': async (args) => {
        try {
          const name = typeof args.name === 'string' ? args.name : '';
          if (!name) return { ok: false, error: 'plugin name is required' };
          const scope = args.scope === 'workspace' ? 'workspace' : 'user';
          const action = args.action === 'enable' ? 'enable' : 'install';
          const res = await pluginConsentSummary(name, workspaceRoot, scope);
          // Echo the pending action/scope back so the renderer can pair the
          // returned disclosure with the button the user clicked.
          if (res.ok) return { ok: true, summary: res.summary, action, scope };
          return res;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      'action:plugin-install': (args) => {
        try {
          const scope = args.scope === 'workspace' ? 'workspace' : 'user';
          const force = args.force === true;
          if (typeof args.source === 'string' && args.source.trim()) {
            return installPluginFromSource(args.source.trim(), { scope, workspaceRoot, ref: typeof args.ref === 'string' ? args.ref : undefined, force });
          }
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) return { ok: false, error: 'plugin name or source is required' };
          return installPluginFromRegistry(name, { scope, workspaceRoot, force });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      'action:plugin-enable': (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'plugin name is required' };
        return setPluginEnabledBridge(name, args.enabled !== false);
      },
      'action:plugin-consent-set': (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'plugin name is required' };
        return setPluginConsentBridge(name, {
          shell: typeof args.shell === 'boolean' ? args.shell : undefined,
          mcp: typeof args.mcp === 'boolean' ? args.mcp : undefined,
        });
      },
      'action:plugin-remove': (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'plugin name is required' };
        const scope = args.scope === 'workspace' ? 'workspace' : 'user';
        return removePluginBridge(name, { scope, workspaceRoot });
      },
      'action:connector-record-run': (args) => {
        try {
          const run = recordConnectorRun(workspaceRoot, {
            connectorId: typeof args.connectorId === 'string' ? args.connectorId : '',
            flow: args.flow as ConnectorFlow,
            status: args.status as never,
            documentsSeen: typeof args.documentsSeen === 'number' ? args.documentsSeen : undefined,
            documentsIndexed: typeof args.documentsIndexed === 'number' ? args.documentsIndexed : undefined,
            permissionsSeen: typeof args.permissionsSeen === 'number' ? args.permissionsSeen : undefined,
            permissionsIndexed: typeof args.permissionsIndexed === 'number' ? args.permissionsIndexed : undefined,
            failures: typeof args.failures === 'number' ? args.failures : undefined,
            error: typeof args.error === 'string' ? args.error : undefined,
            checkpointBefore: args.checkpointBefore && typeof args.checkpointBefore === 'object' && !Array.isArray(args.checkpointBefore) ? args.checkpointBefore as never : undefined,
            checkpointAfter: args.checkpointAfter && typeof args.checkpointAfter === 'object' && !Array.isArray(args.checkpointAfter) ? args.checkpointAfter as never : undefined,
          });
          return { ok: true, run, connector: getConnector(workspaceRoot, run.connectorId) ?? null };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      'action:connector-validate': async (args) => validateGithubConnector(typeof args.id === 'string' ? args.id : ''),
      'action:connector-run': async (args) => runConnector(typeof args.id === 'string' ? args.id : ''),
      'action:connector-index-memory': async (args) => indexConnectorMemory(typeof args.id === 'string' ? args.id : ''),
      'action:connector-sync-permissions': async (args) => syncConnectorPermissions(typeof args.id === 'string' ? args.id : ''),
      // DESK-5d — current branch's PR, for the project-row status chip.
      // Quietly null when gh is missing, unauthenticated, or there is no PR.
      'git-pr': async () => {
        const now = Date.now();
        const cachedPr = getPrCache();
        if (cachedPr && now - cachedPr.at < 60_000) return { pr: cachedPr.pr };
        const view = await ghJson<{ number?: number; state?: string; title?: string }>(['pr', 'view', '--json', 'number,state,title'], { timeout: 4_000, maxBuffer: 200_000 });
        const j = view.data;
        const pr = typeof j?.number === 'number' ? { number: j.number, state: String(j.state ?? 'OPEN'), title: j.title } : null;
        setPrCache({ at: now, pr });
        return view.error ? { pr, error: view.error } : { pr };
      },
      // T6 — GitHub CI/CD via gh. Read-only except action:git-actions-rerun-failed.
      // execFile (NO shell) + numeric-sanitized run ids + clamped limits. Every
      // call degrades to an empty/null payload when gh is missing/unauthed/no-PR,
      // so the panel shows "not connected" instead of erroring. This is GitHub's
      // real CI truth — the renderer keeps it SEPARATE from the local "tests passed".
      // Every OPEN PR in the repo (not just the current branch's) — powers the
      // Review panel's "Pull Requests" tab. Includes the body so the panel can
      // show PR content inline. Degrades to [] when gh is missing/unauthed.
      'git-pr-list': async () => {
        const list = await ghJson<unknown[]>(
          ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,state,url,headRefName,baseRefName,author,isDraft,body,updatedAt'],
          { timeout: 8_000, maxBuffer: 4_000_000, allowNonZeroJson: true },
        );
        return list.error ? { prs: [], error: list.error } : { prs: list.data ?? [] };
      },
      // §session-pr — a compact ALL-STATES PR list (open + merged + closed) keyed
      // later by headRefName so the sidebar can show each session's PR status.
      // Cached ~60s; degrades to [] when gh is missing/unauthed.
      'git-pr-status-map': async () => {
        const now = Date.now();
        const cachedPrMap = getPrStatusMapCache();
        if (cachedPrMap && now - cachedPrMap.at < 60_000) return { prs: cachedPrMap.prs };
        const list = await ghJson<unknown[]>(
          ['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,state,headRefName,isDraft,mergeable,url'],
          { timeout: 12_000, maxBuffer: 4_000_000, allowNonZeroJson: true },
        );
        const prs = list.data ?? [];
        setPrStatusMapCache({ at: now, prs });
        return list.error ? { prs, error: list.error } : { prs };
      },
      'git-pr-detail': async () => {
        const view = await ghJson<TrackPrView & { author?: { login?: string } }>(
          ['pr', 'view', '--json', 'number,state,title,url,headRefName,baseRefName,author,isDraft,mergeable,statusCheckRollup'],
          { timeout: 8_000, maxBuffer: 2_000_000 },
        );
        return view.error ? { pr: null, error: view.error } : { pr: view.data ?? null };
      },
      'git-pr-checks': async () => {
        // `gh pr checks` exits non-zero when checks are pending/failing but still
        // prints JSON — capture stdout regardless of the exit code.
        const checks = await ghJson<unknown[]>(
          ['pr', 'checks', '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'],
          { timeout: 8_000, maxBuffer: 2_000_000, allowNonZeroJson: true },
        );
        return checks.error ? { checks: [], error: checks.error } : { checks: checks.data ?? [] };
      },
      'git-actions-runs': async (args) => {
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50);
        const runs = await ghJson<unknown[]>(
          ['run', 'list', '--limit', String(limit), '--json', 'databaseId,name,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url'],
          { timeout: 9_000, maxBuffer: 4_000_000 },
        );
        return runs.error ? { runs: [], error: runs.error } : { runs: runs.data ?? [] };
      },
      'git-actions-run-detail': async (args) => {
        const id = String(args.id ?? '').replace(/[^0-9]/g, '');
        if (!id) return { run: null, error: 'No run id.' };
        const run = await ghJson<unknown>(
          ['run', 'view', id, '--json', 'databaseId,name,displayTitle,status,conclusion,jobs,workflowName,headBranch,url,createdAt'],
          { timeout: 9_000, maxBuffer: 4_000_000 },
        );
        return run.error ? { run: null, error: run.error } : { run: run.data ?? null };
      },
      'git-actions-run-log': async (args) => {
        const id = String(args.id ?? '').replace(/[^0-9]/g, '');
        if (!id) return { log: '', error: 'No run id.' };
        const flag = args.failedOnly ? '--log-failed' : '--log';
        const log = await ghText(['run', 'view', id, flag], { timeout: 15_000, maxBuffer: 8_000_000 });
        return { log: log.stdout.slice(0, 200_000), error: log.ok ? undefined : (log.error ?? 'gh run log failed') };
      },
      'action:git-actions-rerun-failed': async (args) => {
        const id = String(args.id ?? '').replace(/[^0-9]/g, '');
        if (!id) return { ok: false, error: 'No run id.' };
        const rerun = await ghText(['run', 'rerun', id, '--failed'], { timeout: 10_000, maxBuffer: 200_000 });
        return rerun.ok ? { ok: true, id } : { ok: false, error: rerun.error ?? 'Rerun failed.' };
      },
      'recap': (args) => {
        const key = typeof args.sessionKey === 'string' ? args.sessionKey : getActiveAgent().sessionKey;
        // OOM-safe: recap summarizes recent state — a bounded tail is enough.
        return buildRecap({ entries: readTranscriptTail(workspaceRoot, key, 2000), sessionKey: key });
      },
      // DESK-5w — running background tasks for the active workspace. Rows keep
      // parentSessionKey for transcript lookup, but the renderer shows them in
      // Background tasks rather than as chat-list children.
      'fleet': () => {
        const tasks = collectRunningTasks(workspaceRoot) as Array<{ kind: string; id: string; label: string; startedAt?: string; role?: string; worktree?: boolean }>;
        const sessions = listSessions(workspaceRoot);
        const workers = listWorkers(workspaceRoot);
        const live = tasks.map((t) => {
          let parentSessionKey: string | null = null;
          if (t.kind === 'agent') parentSessionKey = sessions.find((s) => s.id === t.id)?.parentSessionKey ?? null;
          else if (t.kind === 'worker') parentSessionKey = workers.find((w) => w.id === t.id)?.parentSessionKey ?? null;
          return { ...t, parentSessionKey };
        });
        // Merge the DURABLE active tasks (plan revisions, reviews, attachment
        // jobs) — they're file-backed so they survive switches/reload and aren't
        // in the live in-process fleet. parentSessionKey = the launching session.
        const durable = collectDurableRunningTasks(workspaceRoot).map((t) => ({
          kind: t.kind, id: t.id, label: t.title, startedAt: t.startedAt ?? t.createdAt,
          parentSessionKey: t.sessionKey, durable: true, status: t.status,
          phase: currentPhase(t), transcript: t.transcript,
          requirementId: t.requirementId, planId: t.planId,
        }));
        return [...durable, ...live];
      },
      // §3 — the DURABLE task list (survives switches/reload). Scope: a session
      // (default), the whole workspace, or everything; `status` filters active
      // vs all. Each row carries elapsed-time inputs + the transcript ref so the
      // panel can show status/elapsed/workspace/session/requirement/plan + open it.
      'tasks-list': (a) => {
        const scope = typeof a.scope === 'string' ? a.scope : 'session';
        const status: 'active' | 'all' = a.status === 'all' ? 'all' : 'active';
        const sessionKey = scope === 'session' ? (typeof a.sessionKey === 'string' ? a.sessionKey : getActiveAgent().sessionKey) : undefined;
        const rows = listBackgroundTasks(workspaceRoot, { sessionKey, status });
        return rows.map((t) => ({ ...t, phase: currentPhase(t), workspaceRoot }));
      },
      // Desktop starter surface for the same suggested-task scanner the CLI
      // uses. Read-only GitHub REST scan; a human starts work by picking one of
      // the ready-to-run prompts in the Tasks panel.
      'suggested-tasks': async (a) => scanSuggestedTasks(workspaceRoot, {
        repo: typeof a.repo === 'string' ? a.repo : undefined,
        mentionHandle: getCliKnobs().triggers.mentionHandle,
      }),
      'task-detail': (a) => {
        const t = getBackgroundTask(workspaceRoot, typeof a.id === 'string' ? a.id : '');
        return t ? { ...t, phase: currentPhase(t) } : null;
      },
      // §5 — ATTACHMENTS. Ingest a dropped/picked file (a path, or base64 bytes
      // from the renderer) into a durable attachment record as a visible task:
      // preserve the original, extract text/metadata, capture to memory. Returns
      // the record; a failure returns { ok:false, error } so the UI can surface it.
      // An attachment is CONTENT, not a process — it gets a durable AttachmentRecord
      // (its own id/lifecycle, id-linked to the session + memory), NOT a background
      // task. Ingestion is a fast synchronous extract, exactly like the CLI's
      // /attach. (It used to be wrapped in a kind:'attachment' BackgroundTask, which
      // made every upload show up as a transient job in the Background-tasks panel.)
      'attachment-ingest': async (a) => {
        const sessionKey = getActiveAgent().sessionKey;
        const name = typeof a.name === 'string' ? a.name : '';
        const startedAt = Date.now();
        try {
          let source: { kind: 'path'; path: string } | { kind: 'bytes'; name: string; data: Buffer };
          if (typeof a.path === 'string' && a.path) source = { kind: 'path', path: a.path };
          else if (typeof a.dataBase64 === 'string') source = { kind: 'bytes', name: name || 'file', data: Buffer.from(a.dataBase64, 'base64') };
          else throw new Error('attachment-ingest needs a path or dataBase64.');
          const record = await ingestAttachment({
            workspaceRoot, sessionKey,
            requirementId: typeof a.requirementId === 'string' ? a.requirementId : undefined,
            source,
          });
          try {
            const memoryId = (await emitAgentEvent(
              { mcpClient, sessionKey },
              {
                kind: 'agent_output',
                summary: `Attachment ${record.id}: ${record.name} [${record.kind}] ${record.mimeType}`,
                payload: { attachmentId: record.id, name: record.name, kind: record.kind, mimeType: record.mimeType, byteSize: record.byteSize, pageCount: record.pageCount, context: attachmentContextMarkdown(record, { maxChars: 4_000 }) },
              },
            )) ?? undefined;
            if (memoryId) linkAttachmentMemory(workspaceRoot, record.id, memoryId);
          } catch { /* advisory */ }
          recordTelemetry({ name: TELEMETRY_EVENTS.attachment_ingested, workspaceRoot, sessionKey, ok: true, durationMs: Date.now() - startedAt, props: { kind: record.kind, bytes: record.byteSize } });
          return { ok: true, attachment: record, contextMarkdown: attachmentContextMarkdown(record, { maxChars: 3_000 }) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recordTelemetry({ name: TELEMETRY_EVENTS.attachment_ingested, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt, error: msg });
          return { ok: false, error: msg };
        }
      },
      'attachment-list': (a) => {
        const sessionKey = a.scope === 'workspace' ? undefined : (typeof a.sessionKey === 'string' ? a.sessionKey : getActiveAgent().sessionKey);
        return listAttachments(workspaceRoot, { sessionKey });
      },
      'attachment-read': (a) => {
        const rec = getAttachment(workspaceRoot, typeof a.id === 'string' ? a.id : '');
        if (!rec) return null;
        // For images, hand back a (size-capped) data URI so the panel can preview
        // without a second file-protocol round-trip; text/pdf use extractedText.
        let dataUri: string | undefined;
        if (rec.kind === 'image' && rec.byteSize < 5_000_000) {
          try { dataUri = `data:${rec.mimeType};base64,${fs.readFileSync(rec.storedPath).toString('base64')}`; } catch { /* unreadable blob */ }
        }
        return { ...rec, dataUri };
      },
      'attachment-context': (a) => {
        const rec = getAttachment(workspaceRoot, typeof a.id === 'string' ? a.id : '');
        return rec ? { id: rec.id, name: rec.name, markdown: attachmentContextMarkdown(rec) } : null;
      },
      // DESK-5l — live model, not the boot-time snapshot: session-info runs on
      // every sidebar refresh, and returning stale llm.model used to stomp the
      // UI back to the old model right after a switch.
      'session-info': () => {
        const current = syncActiveSessionLlm();
        return { sessionKey: getActiveAgent().sessionKey, model: getActiveAgent().getModel?.() ?? current.model, workspaceRoot, username: os.userInfo().username };
      },
      // DESK-4d — the home/greeting view: real numbers from the workspace's
      // persisted transcripts (sessions, messages, active days, streaks, and
      // a per-day activity map for the heatmap).
      'home-stats': () => {
        const transcripts = listTranscripts(workspaceRoot, { limit: 200 });
        let turns = 0;
        const perDay = new Map<string, number>();
        for (const t of transcripts) {
          turns += t.turnCount;
          const ts = new Date(t.modifiedAt);
          if (!Number.isNaN(ts.getTime())) {
            const day = ts.toISOString().slice(0, 10);
            perDay.set(day, (perDay.get(day) ?? 0) + t.turnCount);
          }
        }
        // streaks over the per-day activity map
        const today = new Date();
        const dayKey = (offset: number) => {
          const d = new Date(today);
          d.setDate(d.getDate() - offset);
          return d.toISOString().slice(0, 10);
        };
        let current = 0;
        for (let i = 0; perDay.has(dayKey(i)); i++) current++;
        let longest = 0, run = 0;
        for (let i = 0; i < 365; i++) {
          if (perDay.has(dayKey(i))) { run++; longest = Math.max(longest, run); } else run = 0;
        }
        return {
          sessions: transcripts.length,
          turns,
          activeDays: perDay.size,
          currentStreak: current,
          longestStreak: longest,
          model: getActiveAgent().getModel?.() ?? getLlm().model,
          perDay: Object.fromEntries(perDay),
        };
      },
      // DESK-4c — workspace browsing panels. (DESK-6t — async git, non-blocking.)
      'list-files': async (args) => listWorkspaceFilesCached(args),
      // DESK-6w (T9) — directory-aware: a folder path returns a typed listing
      // instead of the old raw EISDIR. Pure logic lives in fsRead.ts (tested).
      'read-file': (args) => readWorkspaceEntry(workspaceRoot, typeof args.path === 'string' ? args.path : ''),
      // T5 — in-app editor backend. file-read returns content + mtimeMs/size +
      // binary/truncated flags; file-stat is a cheap mtime probe for stale-write
      // round-tripping. All escape/symlink/stale guards live in fsRead.ts.
      'file-read': (args) => readWorkspaceEntry(workspaceRoot, typeof args.path === 'string' ? args.path : ''),
      'file-stat': (args) => statWorkspaceEntry(workspaceRoot, typeof args.path === 'string' ? args.path : ''),
      // §2 Write mode — save a prose file through the same guarded write the
      // editor uses (writeWorkspaceEntry: escape/symlink/stale guards in fsRead).
      'write-save': (args) => writeWorkspaceEntry(workspaceRoot, typeof args.path === 'string' ? args.path : '', typeof args.content === 'string' ? args.content : ''),
      // §2 W3 — Write-mode selection inline AI. A one-shot, read-only model call
      // (no tools) that polishes / rewrites / continues the selected prose; the
      // panel reviews the result as an accept/reject diff before it lands.
      'write-inline-ai': async (args) => {
        const action = String(args.action ?? 'polish');
        const text = typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) return { text: '', error: 'No text selected.' };
        const llm = llmForSession(getActiveAgent().sessionKey);
        if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
          return { text: '', error: 'No model configured — set a provider/model (and API key) in Settings.' };
        }
        const system = 'You are a precise writing assistant. Return ONLY the revised prose — no preamble, no explanation, no surrounding code fences. Preserve Markdown formatting.';
        const ask = action === 'continue'
          ? 'Continue the following text naturally, matching its voice and style. Return ONLY the continuation (it will be appended directly after the text).'
          : action === 'rewrite'
            ? 'Rewrite the following text to be clearer and better structured. Preserve the meaning and any Markdown.'
            : 'Lightly polish the following text: fix grammar, tighten wording, and improve flow. Preserve the meaning, voice, and any Markdown.';
        let raw = '';
        try {
          const resp = await callOpenAI(llm, [{ role: 'system', content: system }, { role: 'user', content: `${ask}\n\n---\n${text}` }], [], { effort: 'low' });
          raw = (resp?.content as string) ?? '';
        } catch (e) {
          return { text: '', error: `Model call failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        let revised = raw.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        if (action === 'continue') revised = text + (/\s$/.test(text) ? '' : ' ') + revised;
        return { text: revised };
      },
      // §2 W4 — Write-mode ghost-text inline completion. A short, fast, read-only
      // continuation of the text before the cursor; the editor renders it as a
      // ghost suggestion (Tab accepts). Empty answer ⇒ no suggestion.
      'write-ghost-complete': async (args) => {
        const prefix = typeof args.prefix === 'string' ? args.prefix : '';
        if (prefix.trim().length < 3) return { text: '' };
        const llm = llmForSession(getActiveAgent().sessionKey);
        if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) return { text: '' };
        const system = 'You are an inline writing autocomplete. Continue the user\'s text by a few words up to one sentence. Return ONLY the continuation that comes immediately AFTER their text — never repeat their text, no quotes, no preamble. If nothing natural follows, return an empty string.';
        let raw = '';
        try {
          const resp = await callOpenAI(llm, [{ role: 'system', content: system }, { role: 'user', content: prefix.slice(-2000) }], [], { effort: 'low' });
          raw = (resp?.content as string) ?? '';
        } catch { return { text: '' }; }
        // Keep it short + single-line so the ghost stays unobtrusive.
        const text = raw.replace(/^\s+/, '').split('\n')[0].slice(0, 160);
        return { text };
      },
      // §2 W5 — Write-mode assistant: a per-workspace thread (writeThreadKey, kept
      // separate from code chats) grounded on the workspace's prose docs. The
      // brain's recall is primary when online; here we add a cheap local keyword
      // grounding over the Markdown files so the answer cites real workspace docs.
      'write-assistant': async (args) => {
        const question = typeof args.question === 'string' ? args.question : '';
        if (!question.trim()) return { text: '', error: 'Ask a question.' };
        const llm = llmForSession(writeThreadKey(workspaceRoot));
        if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
          return { text: '', error: 'No model configured — set a provider/model (and API key) in Settings.' };
        }
        let grounding = '';
        try {
          const listed = await listWorkspaceFilesCached({ limit: 3000 });
          const mdPaths = (listed.files ?? [])
            .map((f) => (typeof f === 'string' ? f : (f as { path?: string }).path))
            .filter((p): p is string => !!p && /\.(md|markdown|mdx|txt)$/i.test(p))
            .slice(0, 60);
          const docs = mdPaths
            .map((p) => { const r = readWorkspaceEntry(workspaceRoot, p) as { content?: string }; return { path: p, content: typeof r?.content === 'string' ? r.content : '' }; })
            .filter((d) => d.content.trim());
          const current = typeof args.currentPath === 'string' ? args.currentPath : undefined;
          grounding = buildGroundingBlock(pickLocalGrounding(question, docs, current, 3));
        } catch { /* grounding is best-effort */ }
        const system = 'You are a writing assistant for this workspace. Be concise and practical.' +
          (grounding ? ' Ground your answer in the provided workspace documents and cite the source path when you rely on one.' : '');
        const user = grounding ? `${grounding}\n\n---\nQuestion: ${question}` : question;
        try {
          const resp = await callOpenAI(llm, [{ role: 'system', content: system }, { role: 'user', content: user }], [], { effort: 'low' });
          return { text: ((resp?.content as string) ?? '').trim(), grounded: !!grounding };
        } catch (e) {
          return { text: '', error: `Model call failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
      // §7 L4 — visual workflow canvas persistence (graphs under <stateDir>/workflows/).
      'workflow-list': () => listWorkflowGraphs(workspaceRoot),
      'workflow-save': (args) => saveWorkflowGraph(workspaceRoot, (args.graph ?? {}) as WorkflowGraph),
      'workflow-load': (args) => loadWorkflowGraph(workspaceRoot, typeof args.id === 'string' ? args.id : ''),
      'workflow-delete': (args) => ({ ok: deleteWorkflowGraph(workspaceRoot, typeof args.id === 'string' ? args.id : '') }),
      // §5.9 — customizable keyboard shortcuts: read/persist user overrides in
      // cli.shortcuts (action id → neutral combo). Both heads read the same file.
      'shortcuts-get': () => {
        const cli = (loadConfig() as { cli?: { shortcuts?: Record<string, string> } }).cli;
        return { overrides: (cli?.shortcuts && typeof cli.shortcuts === 'object') ? cli.shortcuts : {} };
      },
      'shortcuts-save': (args) => {
        const raw = (args.overrides && typeof args.overrides === 'object') ? (args.overrides as Record<string, unknown>) : {};
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
        const fresh = loadConfig() as { cli?: Record<string, unknown> };
        fresh.cli = { ...(fresh.cli ?? {}), shortcuts: clean };
        saveConfig(fresh as Parameters<typeof saveConfig>[0]);
        _resetCliKnobsCache();
        return { ok: true, overrides: clean };
      },
      // §5.3 Memory panel — search the brain memory engine via the MCP tool.
      // Robust to the loose memory_search shape: structured records when it
      // returns JSON, otherwise the raw text. Surfaces a clear "is the brain
      // connected?" error when the MCP isn't available.
      'memory-search': async (args) => {
        try {
          const result = await mcpClient.callTool('memory_search', { query: typeof args.query === 'string' ? args.query : '' });
          const text = typeof result === 'string'
            ? result
            : ((result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(result));
          try {
            const parsed = JSON.parse(text) as unknown;
            const records = Array.isArray(parsed)
              ? parsed
              : ((parsed as { records?: unknown[]; results?: unknown[]; memories?: unknown[] })?.records
                ?? (parsed as { results?: unknown[] })?.results
                ?? (parsed as { memories?: unknown[] })?.memories
                ?? []);
            return { records, raw: Array.isArray(records) && records.length ? '' : text };
          } catch {
            return { records: [], raw: text };
          }
        } catch (e) {
          return { records: [], error: e instanceof Error ? e.message : String(e) };
        }
      },
      // DESK-4j — branch picker (pattern: branch chip with dropdown in the
      // composer context row). Listing is read-only; checkout runs through
      // the same user-command path as the terminal input.
      'git-branches': async () => {
        const out = await git(['branch', '--list', '--sort=-committerdate'], workspaceRoot);
        const branches = out.split('\n').map((l) => l.replace(/^[*+]?\s*/, '').trim()).filter(Boolean).slice(0, 20);
        const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
        return { current: current || null, branches };
      },
      // DESK-4m — recent commit subjects for the Environment panel.
      'git-log': async () => ({ subjects: (await git(['log', '-5', '--pretty=%s'], workspaceRoot)).split('\n').filter(Boolean) }),
      'git-info': async () => {
        // DESK-6w (T4) — repo name from the OWNING git root (so a subdir workspace
        // shows "BrainRouter", not "brainrouter-desktop"); diff scoped to the
        // workspace subtree (`-- .`) so a monorepo subfolder doesn't report the
        // parent's churn. workspaceRoot/gitRoot/repoRelativePath feed the env panel.
        const base = {
          repo: wsGit.repoName, workspaceRoot, gitRoot: wsGit.gitRoot,
          repoRelativePath: wsGit.repoRelativePath, isSubdir: wsGit.isSubdir,
          // ADR-015 — the repo identity used to MATCH this workspace to a linked
          // GitHub repo (survives http↔ssh remotes / a moved folder / a 2nd clone).
          remoteUrl: wsGit.remoteUrl, repoIdentity: wsGit.repoIdentity, repoTag: wsGit.repoTag,
        };
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
        if (!branch) return { ...base, branch: null, files: 0, insertions: 0, deletions: 0 };
        const stat = await git(['diff', 'HEAD', '--shortstat', '--', '.'], workspaceRoot);
        return {
          ...base, branch,
          files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0),
          insertions: Number(/(\d+) insertions?/.exec(stat)?.[1] ?? 0),
          deletions: Number(/(\d+) deletions?/.exec(stat)?.[1] ?? 0),
        };
      },
      // DESK-4 — diff/review surfaces. git-backed, tolerant of non-repos.
      // DESK-6w (T4) — `-- .` scopes to the workspace subtree with workspace-
      // relative paths (so file-open/diff resolution is unchanged).
      'changed-files': async () => (await git(['status', '--porcelain', '--', '.'], workspaceRoot))
        .split('\n').filter(Boolean).slice(0, 200).map((line) => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3).trim() })),
      'file-diff': async (args) => {
        const file = typeof args.path === 'string' ? args.path : '';
        if (!file) return { path: file, diff: '' };
        // DESK-6w (T9) — a directory has no single-file diff; return a typed
        // payload rather than letting `git diff --no-index` misbehave on a folder.
        if (isWorkspaceDirectory(workspaceRoot, file)) return { path: file, kind: 'directory', diff: '' };
        // HEAD diff covers staged + unstaged; untracked files get a synthetic add-diff
        // (git diff --no-index exits 1 but its stdout — captured by `git` — IS the diff).
        let diff = await git(['diff', 'HEAD', '--', file], workspaceRoot, { maxBuffer: 4_000_000 });
        if (!diff.trim()) diff = await git(['diff', '--no-index', '--', '/dev/null', file], workspaceRoot, { maxBuffer: 4_000_000 });
        return { path: file, kind: 'file', diff: diff.slice(0, 200_000) };
      },
      // End-of-turn changeset — per-file numstat for the files the agent edited
      // THIS turn (paths come from the renderer's turn tracking). Covers tracked
      // (staged+unstaged) churn plus untracked new files (synth add-diff), so the
      // transcript card can show "Edited N files +X −Y" with accurate per-file +/-.
      'turn-changeset': async (args) => {
        const paths = Array.isArray(args.paths)
          ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 200)
          : [];
        if (!paths.length) return { files: [], insertions: 0, deletions: 0 };
        const stat = new Map<string, { added: number; removed: number }>();
        const numstat = await git(['diff', 'HEAD', '--numstat', '--', ...paths], workspaceRoot, { maxBuffer: 4_000_000 }).catch(() => '');
        for (const line of numstat.split('\n').filter(Boolean)) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;
          stat.set(parts.slice(2).join('\t'), {
            added: parts[0] === '-' ? 0 : Number(parts[0]) || 0,
            removed: parts[1] === '-' ? 0 : Number(parts[1]) || 0,
          });
        }
        const statusByPath = new Map<string, string>();
        const porcelain = await git(['status', '--porcelain', '--', ...paths], workspaceRoot).catch(() => '');
        for (const line of porcelain.split('\n').filter(Boolean)) statusByPath.set(line.slice(3).trim(), line.slice(0, 2).trim() || 'M');
        // Untracked new files have no HEAD numstat — count their lines via add-diff.
        for (const p of paths) {
          if (stat.has(p)) continue;
          if (statusByPath.get(p) === '??' || !statusByPath.has(p)) {
            const add = await git(['diff', '--no-index', '--numstat', '--', '/dev/null', p], workspaceRoot).catch(() => '');
            const first = add.split('\n').filter(Boolean)[0];
            if (first) {
              const parts = first.split('\t');
              stat.set(p, { added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 });
              if (!statusByPath.has(p)) statusByPath.set(p, 'A');
            }
          }
        }
        const files = paths
          .map((p) => ({ path: p, status: statusByPath.get(p) || 'M', added: stat.get(p)?.added ?? 0, removed: stat.get(p)?.removed ?? 0 }))
          .filter((f) => f.added || f.removed || statusByPath.has(f.path));
        return {
          files,
          insertions: files.reduce((s, f) => s + f.added, 0),
          deletions: files.reduce((s, f) => s + f.removed, 0),
        };
      },
      // T13 — git worktrees (repo-level, so operate on the git root). The host
      // returns the raw porcelain; the renderer owns the (tested) parser.
      'git-worktrees': async () => {
        const root = wsGit.gitRoot ?? workspaceRoot;
        const raw = await git(['worktree', 'list', '--porcelain'], root);
        return { raw, gitRoot: root, current: workspaceRoot };
      },
      'worktree-diff': async (args) => {
        const wtPath = typeof args.path === 'string' ? args.path : '';
        if (!wtPath || !fs.existsSync(wtPath)) return { path: wtPath, diff: '', files: 0 };
        const diff = await git(['diff', 'HEAD'], wtPath, { maxBuffer: 4_000_000 });
        const stat = await git(['diff', 'HEAD', '--shortstat'], wtPath);
        return { path: wtPath, diff: diff.slice(0, 200_000), files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0) };
      },
      'worktree-create': async (args) => {
        const name = String(args.name ?? '').trim();
        const ref = String(args.ref ?? '').trim() || 'HEAD';
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return { ok: false, error: 'Name must be letters, digits, dash, underscore or dot.' };
        const root = wsGit.gitRoot ?? workspaceRoot;
        const wtPath = path.join(root, '.worktrees', name);
        // execFile-based git() never invokes a shell, so name/ref aren't shell-expanded.
        const out = await git(['worktree', 'add', wtPath, ref], root);
        if (!fs.existsSync(wtPath)) return { ok: false, error: out.trim() || `Failed to create worktree "${name}".` };
        return { ok: true, path: wtPath };
      },
      'worktree-remove': async (args) => {
        const wtPath = String(args.path ?? '').trim();
        const root = wsGit.gitRoot ?? workspaceRoot;
        if (!wtPath) return { ok: false, error: 'No worktree path.' };
        await git(['worktree', 'remove', '--force', wtPath], root);
        await git(['worktree', 'prune'], root);
        return { ok: !fs.existsSync(wtPath) };
      },
      // REQUIREMENT-RECORDS — Requirement Records: per-workspace structured units
      // of intent (title, status, priority, acceptance criteria, clarifying Q&A,
      // TRACK mode — the per-workspace project board. Thin wrappers over the
      // shared trackStore (track.json), so the Track surface, the CLI, and the
      // agent tools all read/write one project per workspace. Mutations return
      // the refreshed item list so the renderer repaints in one round-trip.
      'track-project': () => getProject(workspaceRoot) ?? ensureProject(workspaceRoot),
      'track-items': () => listWorkItems(workspaceRoot),
      'track-create': (a) => {
        const input: CreateWorkItemInput = {
          title: String(a.title ?? 'Untitled'),
          type: (typeof a.type === 'string' ? a.type : 'task') as WorkItemType,
          status: typeof a.status === 'string' ? a.status : undefined,
          sessionKey: getActiveAgent().sessionKey,
          actor: 'user',
        };
        createWorkItem(workspaceRoot, input);
        return listWorkItems(workspaceRoot);
      },
      'track-transition': (a) => {
        transitionWorkItem(workspaceRoot, String(a.idOrKey ?? ''), String(a.toStatus ?? ''), 'user');
        return listWorkItems(workspaceRoot);
      },
      // General field patch (assignee/priority/labels/sprint/epic/parent/title/desc).
      'track-update-item': (a) => {
        const patch = (a.patch && typeof a.patch === 'object' ? a.patch : {}) as UpdateWorkItemPatch;
        updateWorkItem(workspaceRoot, String(a.idOrKey ?? ''), patch, 'user');
        return listWorkItems(workspaceRoot);
      },
      'track-comment': (a) => {
        addComment(workspaceRoot, String(a.idOrKey ?? ''), 'user', String(a.body ?? ''));
        return listWorkItems(workspaceRoot);
      },
      'track-link': (a) => {
        linkWorkItem(workspaceRoot, String(a.idOrKey ?? ''), {
          codeLinks: Array.isArray(a.codeLinks) ? (a.codeLinks as CodeLink[]) : undefined,
          linkedMemoryIds: Array.isArray(a.linkedMemoryIds) ? (a.linkedMemoryIds as string[]) : undefined,
          links: typeof a.blocks === 'string' ? [{ type: 'blocks', targetId: a.blocks }] : undefined,
        });
        return listWorkItems(workspaceRoot);
      },
      'track-assign-sprint': (a) => {
        updateWorkItem(workspaceRoot, String(a.idOrKey ?? ''), { sprintId: a.sprintId ? String(a.sprintId) : undefined }, 'user');
        return listWorkItems(workspaceRoot);
      },
      'track-sprints': () => { ensureProject(workspaceRoot); return listSprints(workspaceRoot); },
      'track-create-sprint': (a) => {
        createSprint(workspaceRoot, { name: String(a.name ?? 'Sprint'), goal: a.goal ? String(a.goal) : undefined });
        return listSprints(workspaceRoot);
      },
      'track-sprint-state': (a) => {
        setSprintState(workspaceRoot, String(a.id ?? ''), String(a.state ?? 'future') as SprintState);
        return listSprints(workspaceRoot);
      },
      // Modules — feature-sized groupings of work items.
      'track-modules': () => { ensureProject(workspaceRoot); return listModules(workspaceRoot); },
      'track-create-module': (a) => {
        createModule(workspaceRoot, { name: String(a.name ?? 'Module'), description: a.description ? String(a.description) : undefined });
        return listModules(workspaceRoot);
      },
      'track-module-update': (a) => {
        updateModule(workspaceRoot, String(a.id ?? ''), (a.patch && typeof a.patch === 'object' ? a.patch : {}) as UpdateModulePatch);
        return listModules(workspaceRoot);
      },
      'track-module-delete': (a) => { deleteModule(workspaceRoot, String(a.id ?? '')); return listModules(workspaceRoot); },
      'track-assign-module': (a) => {
        updateWorkItem(workspaceRoot, String(a.idOrKey ?? ''), { moduleId: a.moduleId ? String(a.moduleId) : undefined }, 'user');
        return listWorkItems(workspaceRoot);
      },
      // Saved views — filter + layout presets.
      'track-views': () => { ensureProject(workspaceRoot); return listViews(workspaceRoot); },
      'track-save-view': (a) => {
        const input = (a.input && typeof a.input === 'object' ? a.input : {}) as Parameters<typeof saveView>[1];
        if (input.name && input.layout) saveView(workspaceRoot, input);
        return listViews(workspaceRoot);
      },
      'track-delete-view': (a) => { deleteView(workspaceRoot, String(a.id ?? '')); return listViews(workspaceRoot); },
      // Automation rules — trigger → action over the project board.
      'track-automations': () => { ensureProject(workspaceRoot); return listAutomations(workspaceRoot); },
      'track-create-automation': (a) => {
        createAutomation(workspaceRoot, {
          name: String(a.name ?? 'Rule'),
          trigger: (typeof a.trigger === 'string' ? a.trigger : 'created') as AutomationTrigger,
          condition: typeof a.condition === 'string' ? a.condition : undefined,
          actions: Array.isArray(a.actions) ? (a.actions as AutomationAction[]) : [],
        });
        return listAutomations(workspaceRoot);
      },
      'track-update-automation': (a) => {
        const patch = (a.patch && typeof a.patch === 'object' ? a.patch : {}) as AutomationPatch;
        updateAutomation(workspaceRoot, String(a.id ?? ''), patch);
        return listAutomations(workspaceRoot);
      },
      'track-delete-automation': (a) => {
        deleteAutomation(workspaceRoot, String(a.id ?? ''));
        return listAutomations(workspaceRoot);
      },
      // Members & roles — per-project permissions.
      'track-members': () => { ensureProject(workspaceRoot); return listMembers(workspaceRoot); },
      'track-add-member': (a) => {
        addMember(workspaceRoot, { id: String(a.id ?? ''), name: typeof a.name === 'string' ? a.name : undefined, role: (typeof a.role === 'string' ? a.role : 'member') as ProjectRole });
        return listMembers(workspaceRoot);
      },
      'track-update-member-role': (a) => {
        updateMemberRole(workspaceRoot, String(a.id ?? ''), (typeof a.role === 'string' ? a.role : 'member') as ProjectRole);
        return listMembers(workspaceRoot);
      },
      'track-remove-member': (a) => {
        removeMember(workspaceRoot, String(a.id ?? ''));
        return listMembers(workspaceRoot);
      },
      // Pull repo collaborators into the roster (role-mapped). Token resolved
      // server-side; never returned to the renderer.
      'track-sync-members': async (a) => {
        migrateTrackGithubToConnector(workspaceRoot);
        const cfg = resolveGithubConfigForWorkspace(workspaceRoot, typeof a.repo === 'string' ? a.repo : undefined);
        if (cfg.error) return { error: cfg.error };
        if (!cfg.repo) return { error: 'No repository configured. Configure a GitHub connector in Settings → Connectors → GitHub.' };
        if (!cfg.token) return { error: 'No token. Add one to the GitHub connector in Settings → Connectors, or set GITHUB_TOKEN/GH_TOKEN.' };
        return await importMembersFromGithub(workspaceRoot, { repo: cfg.repo, token: cfg.token, fetchImpl: fetch as never, dryRun: a.dryRun === true });
      },
      // External sync — GitHub Issues. The token is resolved server-side from
      // config.json/env and NEVER returned to the renderer. The lazy migration
      // adopts any legacy cli.track.github* config into the workspace's
      // connector the first time the Sync surface is opened (idempotent).
      'track-sync-config': () => {
        migrateTrackGithubToConnector(workspaceRoot);
        return githubIntegrationSnapshot(workspaceRoot);
      },
      // Connector Phase 0 — choose which (connector, repo) this workspace syncs
      // with. `null`/missing connectorId clears the target (back to legacy).
      'track-set-github-target': (a) => {
        const connectorId = typeof a.connectorId === 'string' ? a.connectorId.trim() : '';
        const repo = typeof a.repo === 'string' ? a.repo.trim() : '';
        if (connectorId && repo) setGithubSyncTarget(workspaceRoot, { connectorId, repo });
        else setGithubSyncTarget(workspaceRoot, null);
        return githubIntegrationSnapshot(workspaceRoot);
      },
      // Git-backed Track workflow — local repository context and branch start,
      // independent of GitHub tokens. Remote parsing is context only; mutation is
      // done through local git + Track's codeLinks.
      'track-git-context': () => readGitTrackContext(workspaceRoot),
      'track-start-work': (a) => {
        ensureProject(workspaceRoot);
        const result = startGitWorkForTrackItem(workspaceRoot, String(a.idOrKey ?? ''), {
          branchName: typeof a.branchName === 'string' ? a.branchName : undefined,
          createBranch: a.createBranch !== false,
          actor: 'user',
        });
        return { ...result, items: listWorkItems(workspaceRoot) };
      },
      'track-pr-status': async () => readTrackPrStatus(),
      'track-create-pr': async (a) => createTrackDraftPr(String(a.idOrKey ?? '')),
      'track-gh-issues-import': async (a) => importTrackIssuesFromGh(a),
      'track-merge-pr': async () => mergeCurrentTrackPr(),
      'track-submit-pr-review': async (a) => submitTrackPrReview(a),
      'track-fix-failing-checks': async () => fixCurrentTrackPrChecks(),
      // BR-123 commit scanner — link commits to items + advance todo→in-progress.
      'track-scan-commits': () => {
        ensureProject(workspaceRoot);
        const r = scanGitCommitsForTrack(workspaceRoot, {});
        return { ...r, items: listWorkItems(workspaceRoot) };
      },
      // Connector Phase 1 — repo discovery for the picker. Both queries resolve
      // the CONNECTOR's credential (static token → REST; dynamic/oauth → gh CLI)
      // and never return the token itself.
      'github-connector-orgs': async (a) => {
        const connector = getConnector(workspaceRoot, typeof a.connectorId === 'string' ? a.connectorId : '');
        if (!connector) return { viewer: null, orgs: [], errors: ['Connector not found.'] };
        try {
          if (connector.credential.mode === 'static' || connector.credential.mode === 'oauth') {
            const cred = await githubConnectorToken(connector);
            if (!cred.token) return { viewer: null, orgs: [], errors: [cred.error ?? 'No credential.'] };
            const viewer = await githubTokenJson<{ login?: string }>(connector, cred.token, '/user');
            const orgs = await githubTokenJson<Array<{ login?: string; description?: string | null }>>(connector, cred.token, '/user/orgs?per_page=100');
            return { viewer: viewer.login ? { login: viewer.login } : null, orgs: orgs.map((o) => ({ login: o.login ?? '', description: o.description ?? undefined })).filter((o) => o.login), errors: [] };
          }
          const viewer = await ghJson<{ login?: string }>(['api', 'user'], { timeout: 12_000 });
          if (viewer.error) return { viewer: null, orgs: [], errors: [viewer.error] };
          const orgs = await ghJson<Array<{ login?: string; description?: string | null }>>(['api', 'user/orgs?per_page=100'], { timeout: 12_000, maxBuffer: 1_000_000 });
          return {
            viewer: viewer.data?.login ? { login: viewer.data.login } : null,
            orgs: (orgs.data ?? []).map((o) => ({ login: o.login ?? '', description: o.description ?? undefined })).filter((o) => o.login),
            errors: orgs.error ? [orgs.error] : [],
          };
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          return { viewer: null, orgs: [], errors: [/403|429|rate/i.test(msg) ? 'GitHub API rate limited — try again in a few minutes.' : msg] };
        }
      },
      'github-connector-repos': async (a) => {
        const connector = getConnector(workspaceRoot, typeof a.connectorId === 'string' ? a.connectorId : '');
        const org = typeof a.org === 'string' ? a.org.trim() : '';
        const viewerLogin = typeof a.viewerLogin === 'string' ? a.viewerLogin.trim() : '';
        const page = Number.isFinite(Number(a.page)) && Number(a.page) > 0 ? Math.floor(Number(a.page)) : 1;
        if (!connector || !org) return { repos: [], nextPage: null, errors: [connector ? 'Missing org.' : 'Connector not found.'] };
        type RestRepo = { full_name?: string; private?: boolean; archived?: boolean; fork?: boolean; description?: string | null; pushed_at?: string };
        const mapRepos = (list: RestRepo[]) => list
          .map((r) => ({ nameWithOwner: r.full_name ?? '', isPrivate: !!r.private, isArchived: !!r.archived, isFork: !!r.fork, description: r.description ?? undefined, pushedAt: r.pushed_at ?? undefined }))
          .filter((r) => r.nameWithOwner);
        // The viewer's personal namespace lists via /user/repos (owner affiliation);
        // organizations via /orgs/{org}/repos.
        const apiPath = org === viewerLogin
          ? `/user/repos?affiliation=owner&per_page=100&page=${page}&sort=pushed`
          : `/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&page=${page}&sort=pushed`;
        try {
          if (connector.credential.mode === 'static' || connector.credential.mode === 'oauth') {
            const cred = await githubConnectorToken(connector);
            if (!cred.token) return { repos: [], nextPage: null, errors: [cred.error ?? 'No credential.'] };
            const list = await githubTokenJson<RestRepo[]>(connector, cred.token, apiPath);
            const repos = mapRepos(list);
            return { repos, nextPage: list.length === 100 ? page + 1 : null, errors: [] };
          }
          const list = await ghJson<RestRepo[]>(['api', apiPath.replace(/^\//, '')], { timeout: 20_000, maxBuffer: 4_000_000 });
          if (list.error) return { repos: [], nextPage: null, errors: [list.error] };
          const repos = mapRepos(list.data ?? []);
          return { repos, nextPage: (list.data ?? []).length === 100 ? page + 1 : null, errors: [] };
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          const rateLimited = /403|429|rate/i.test(msg);
          return { repos: [], nextPage: null, rateLimited, errors: [rateLimited ? 'GitHub API rate limited — try again in a few minutes.' : msg] };
        }
      },
      'track-sync': async (a) => {
        const direction = a.direction === 'export' ? 'export' : a.direction === 'sync' ? 'sync' : 'import';
        const dryRun = a.dryRun !== false; // default to dry-run unless explicitly false
        migrateTrackGithubToConnector(workspaceRoot);
        const cfg = resolveGithubConfigForWorkspace(workspaceRoot, typeof a.repo === 'string' ? a.repo : undefined);
        if (cfg.error) return { error: cfg.error };
        if (!cfg.repo) return { error: 'No repository configured. Configure a GitHub connector in Settings → Connectors → GitHub.' };
        if (!cfg.token) return { error: 'No token. Add one to the GitHub connector in Settings → Connectors, or set GITHUB_TOKEN/GH_TOKEN.' };
        const opts = { repo: cfg.repo, token: cfg.token, fetchImpl: fetch as never, dryRun };
        if (direction === 'export') return await exportToGithub(workspaceRoot, opts);
        if (direction === 'sync') return await syncBidirectional(workspaceRoot, opts);
        return await importFromGithub(workspaceRoot, opts);
      },
      // links). Thin wrappers over the CLI's requirementStore (already unit-tested)
      // so the desktop panel and the terminal CLI share the same requirements.json.
      // ATLAS — the codebase knowledge graph. `atlas-graph` loads the stored
      // artifact (or null); `atlas-build` runs the deterministic builder, saves,
      // and returns the fresh graph so the panel renders without a second fetch.
      // REMOTE-BRAIN Phase 3d — with a remote brain configured (cli.brainUrl),
      // the brain is the source of truth: pull the stored graph (caching it
      // locally) and fall back to the local artifact when absent/unreachable.
      'atlas-graph': async () => {
        if (getCliKnobs().brainUrl) {
          const remote = await callBrainAtlas('atlas_get', { workspaceTag: atlasWorkspaceTag(workspaceRoot) });
          if (remote?.found && remote.graph) {
            saveAtlasGraph(workspaceRoot, remote.graph);
            return remote.graph;
          }
        }
        return readAtlasGraph(workspaceRoot);
      },
      'atlas-build': async () => {
        // COST-CACHE — carry the prior enrichment's summaries onto the rebuilt
        // graph (matched by node id) so a rebuild doesn't throw away understanding;
        // the next enrich then only re-pays for files whose structure changed.
        const graph = carryForwardSummaries(buildBaseGraph(workspaceRoot), readAtlasGraph(workspaceRoot));
        saveAtlasGraph(workspaceRoot, graph);
        // Sync the fresh build up so other clients / the dashboard can serve it.
        if (getCliKnobs().brainUrl) await callBrainAtlas('atlas_put', { workspaceTag: atlasWorkspaceTag(workspaceRoot), graph });
        return { graph, stats: atlasGraphStats(graph) };
      },
      // `atlas-enrich` layers LLM understanding (summaries, tags, layers, tour)
      // onto the base graph using the active session's model. Builds the base
      // graph first if none exists. Best-effort — degrades, never throws.
      'atlas-enrich': async () => {
        let graph = readAtlasGraph(workspaceRoot);
        if (!graph) {
          graph = buildBaseGraph(workspaceRoot);
          saveAtlasGraph(workspaceRoot, graph);
        }
        const llm = llmForSession(getActiveAgent().sessionKey);
        if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
          return { error: 'No model configured — set a provider/model (and API key) in Settings before enriching the atlas.' };
        }
        const caller: AtlasLlmCaller = async ({ system, user, signal, tool }) => {
          // STRUCTURED OUTPUT — forward the enrich tool as a forced tool_choice so
          // output is schema-shaped + consistent across models (mirrors the CLI
          // adapter); fall back to message content when the model answers inline.
          const tools = tool ? [{ name: tool.name, description: tool.description ?? '', inputSchema: tool.parameters }] : [];
          const resp = await callOpenAI(
            llm,
            [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            tools,
            { effort: 'low', signal, ...(tool ? { tool_choice: { type: 'function' as const, function: { name: tool.name } } } : {}) },
          );
          const argsText = (resp as { tool_calls?: Array<{ function?: { arguments?: string } }> })?.tool_calls?.[0]?.function?.arguments;
          if (typeof argsText === 'string' && argsText.trim()) return argsText;
          return (resp?.content as string) ?? '';
        };
        const res = await enrichAtlasGraph(graph, caller);
        saveAtlasGraph(workspaceRoot, res.graph);
        if (getCliKnobs().brainUrl) await callBrainAtlas('atlas_put', { workspaceTag: atlasWorkspaceTag(workspaceRoot), graph: res.graph });
        return {
          graph: res.graph,
          stats: atlasGraphStats(res.graph),
          enrichResult: { summarized: res.summarized, layers: res.layers, tourSteps: res.tourSteps, batchesFailed: res.batchesFailed },
        };
      },
      // `atlas-explain-change` reviews ONE uncommitted file with the model:
      // returns a plain-English summary, a risk level, a review checklist, and
      // concerns — so an engineer can understand an AI edit before committing.
      'atlas-explain-change': async (a) => {
        const path = String(a.path ?? '');
        if (!path) return { error: 'No file path given.' };
        const llm = llmForSession(getActiveAgent().sessionKey);
        if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
          return { error: 'No model configured — set a provider/model (and API key) in Settings.' };
        }
        // Working-tree diff vs HEAD; fall back to file content for untracked files.
        let diff = await git(['diff', '--no-color', 'HEAD', '--', path], workspaceRoot).catch(() => '');
        if (!diff.trim()) {
          let content = '';
          try { content = (await import('node:fs')).readFileSync(`${workspaceRoot}/${path}`, 'utf8'); } catch { content = ''; }
          diff = content ? `NEW/UNTRACKED FILE ${path}:\n${content.slice(0, 16000)}` : '';
        }
        if (!diff.trim()) return { error: 'No diff available for this file.' };
        const system = 'You are a senior engineer reviewing an AI-generated code change before commit. Be specific and terse. Answer ONLY with JSON, no prose, no fences.';
        const user = [
          `File: ${path}`,
          'Review this change and return EXACTLY this JSON shape:',
          '{"summary":"1-2 sentences on what changed and why","risk":"low|medium|high","checklist":["what a reviewer should verify", "..."],"concerns":["specific risks/bugs/omissions, [] if none"]}',
          '',
          'Diff (truncated):',
          diff.slice(0, 16000),
        ].join('\n');
        let raw = '';
        try {
          const resp = await callOpenAI(llm, [{ role: 'system', content: system }, { role: 'user', content: user }], [], { effort: 'low' });
          raw = (resp?.content as string) ?? '';
        } catch (e) {
          return { path, error: `Model call failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        const parsed = extractAtlasJson(raw) as { summary?: string; risk?: string; checklist?: unknown; concerns?: unknown } | null;
        if (!parsed || typeof parsed !== 'object') return { path, error: 'Could not parse the model response.' };
        const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : []);
        const risk = ['low', 'medium', 'high'].includes(String(parsed.risk)) ? String(parsed.risk) : 'medium';
        return {
          path,
          assessment: { summary: typeof parsed.summary === 'string' ? parsed.summary : '', risk, checklist: arr(parsed.checklist), concerns: arr(parsed.concerns) },
        };
      },
      'requirement-list': () => listRequirements(workspaceRoot),
      'requirement-create': async (a) => {
        const created = createRequirement(workspaceRoot, { title: String(a.title ?? ''), sessionKey: getActiveAgent().sessionKey });
        await captureRequirementNote(created, 'created');
        return getRequirement(workspaceRoot, created.id) ?? created;
      },
      'requirement-update': async (a) => {
        const id = String(a.id ?? '');
        const patch: RequirementPatch = {};
        let change = '';
        if (a.status !== undefined) {
          if (!isRequirementStatus(a.status)) return { error: `Unknown requirement status "${String(a.status)}".` };
          patch.status = a.status;
          change = `status → ${a.status}`;
        }
        if (a.priority !== undefined) {
          if (!isRequirementPriority(a.priority)) return { error: `Unknown requirement priority "${String(a.priority)}".` };
          patch.priority = a.priority;
          if (!change) change = `priority → ${a.priority}`;
        }
        if (typeof a.criterion === 'string' && a.criterion.trim()) {
          const existing = getRequirement(workspaceRoot, id);
          if (!existing) return { error: `No requirement "${id}".` };
          patch.acceptanceCriteria = [...existing.acceptanceCriteria, a.criterion.trim()];
          change = change ? `${change}; criterion added` : 'criterion added';
        }
        const updated = updateRequirement(workspaceRoot, id, patch);
        if (!updated) return { error: `No requirement "${id}".` };
        if (change) await captureRequirementNote(updated, change);
        return getRequirement(workspaceRoot, updated.id) ?? updated;
      },
      'requirement-delete': (a) => {
        const id = String(a.id ?? '');
        return { ok: deleteRequirement(workspaceRoot, id) };
      },
      'requirement-seed-plan': async (a) => {
        const id = String(a.id ?? '');
        const req = getRequirement(workspaceRoot, id);
        if (!req) return { error: `No requirement "${id}".` };
        if (req.acceptanceCriteria.length === 0) return { error: 'This requirement has no acceptance criteria to seed a plan from.' };
        const plan = seedPlanFromRequirement(workspaceRoot, { id: req.id, acceptanceCriteria: req.acceptanceCriteria }, getActiveAgent().sessionKey);
        // Move the requirement into work once a plan exists (only from a pre-work state).
        if (req.status === 'draft' || req.status === 'clarifying' || req.status === 'ready') {
          updateRequirement(workspaceRoot, id, { status: 'in-progress' });
        }
        await captureRequirementNote(getRequirement(workspaceRoot, id) ?? req, 'plan seeded');
        return { ok: true, items: plan.items };
      },
      // The one-click gate: mark a (draft) requirement ready + run the
      // Requirement → Plan → Track cascade immediately so a board appears now.
      'requirement-promote': async (a) => {
        const id = String(a.id ?? '');
        const req = getRequirement(workspaceRoot, id);
        if (!req) return { error: `No requirement "${id}".` };
        if (req.acceptanceCriteria.length === 0) return { error: 'This requirement has no acceptance criteria yet — add some first.' };
        updateRequirement(workspaceRoot, id, { status: 'ready' });
        const { actions } = syncRequirementPlanTrack(workspaceRoot, getActiveAgent().sessionKey);
        const created = actions.filter((x) => x.kind === 'work-item-created').length;
        await captureRequirementNote(getRequirement(workspaceRoot, id) ?? req, 'promoted to plan + Track');
        return { ok: true, created, requirements: listRequirements(workspaceRoot) };
      },
      // ANNOTATION-RECORDS (0.4.15) — durable feedback records anchored to a
      // plan / requirement / artifact / doc / message / diff / file / review
      // finding. Thin wrappers over the CLI's annotationStore + annotationExport
      // (both already unit-tested) so the desktop panel and the terminal CLI
      // share the same annotations.json. Enum inputs are guard-validated here so
      // a bad targetKind/status/severity is rejected, not silently written.
      // §6 — list, augmented with a transient `stale` flag for file-anchored
      // annotations whose quoted code has since changed (re-hash the current lines
      // and compare against the recorded fingerprint). Read failure → not stale.
      'annotation-list': (a) => listAnnotations(workspaceRoot, withSessionScope(annotationFilterFromArgs(a), a, getActiveAgent().sessionKey)).map((rec) => annotateStale(workspaceRoot, rec)),
      'annotation-create': async (a) => {
        const type = a.type;
        if (!isAnnotationTargetKind(type)) return { error: `Unknown annotation target kind "${String(type)}".` };
        const body = String(a.body ?? '').trim();
        if (!body) return { error: 'Annotation body must be a non-empty string.' };
        if (a.status !== undefined && !isAnnotationStatus(a.status)) return { error: `Unknown annotation status "${String(a.status)}".` };
        if (a.severity !== undefined && !isAnnotationSeverity(a.severity)) return { error: `Unknown annotation severity "${String(a.severity)}".` };
        const input: CreateAnnotationInput = { type, body, sessionKey: getActiveAgent()?.sessionKey };
        if (typeof a.targetId === 'string' && a.targetId) input.targetId = a.targetId;
        if (typeof a.requirementId === 'string' && a.requirementId) input.requirementId = a.requirementId;
        if (typeof a.taskId === 'string' && a.taskId) input.taskId = a.taskId;
        if (typeof a.artifactId === 'string' && a.artifactId) input.artifactId = a.artifactId;
        if (typeof a.suggestedText === 'string' && a.suggestedText.trim()) input.suggestedText = a.suggestedText;
        if (typeof a.author === 'string' && a.author.trim()) input.author = a.author.trim();
        if (a.status !== undefined && isAnnotationStatus(a.status)) input.status = a.status;
        if (a.severity !== undefined && isAnnotationSeverity(a.severity)) input.severity = a.severity;
        const anchor = annotationAnchorFromArgs(a.anchor);
        if (anchor) input.anchor = anchor;
        try {
          const created = createAnnotation(workspaceRoot, input);
          await captureAnnotationNote(created, 'created');
          return getAnnotation(workspaceRoot, created.id) ?? created;
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      'annotation-set-status': async (a) => {
        const id = String(a.id ?? '');
        if (!isAnnotationStatus(a.status)) return { error: `Unknown annotation status "${String(a.status)}".` };
        const updated = setAnnotationStatus(workspaceRoot, id, a.status);
        if (!updated) return { error: `No annotation "${id}".` };
        await captureAnnotationNote(updated, `status → ${updated.status}`);
        const linked = getAnnotation(workspaceRoot, updated.id);
        return linked ? annotateStale(workspaceRoot, linked) : annotateStale(workspaceRoot, updated);
      },
      // §6 COMMENT THREADS — append a comment to an annotation's discussion.
      'annotation-add-comment': async (a) => {
        const id = String(a.id ?? '');
        const body = typeof a.body === 'string' ? a.body.trim() : '';
        if (!body) return { error: 'Comment body must be a non-empty string.' };
        const author = typeof a.author === 'string' && a.author.trim() ? a.author.trim() : undefined;
        try {
          const updated = addAnnotationComment(workspaceRoot, id, body, author);
          if (!updated) return { error: `No annotation "${id}".` };
          await captureAnnotationNote(updated, `comment: ${body.replace(/\s+/g, ' ').slice(0, 80)}`);
          const linked = getAnnotation(workspaceRoot, updated.id);
          return annotateStale(workspaceRoot, linked ?? updated);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      // Render the (optionally filtered) annotations as agent-readable markdown
      // for the renderer to drop into the chat composer — the "export feedback
      // to the session" path. Pure render; the composer draft is set renderer-side.
      'annotation-export': async (a) => {
        const records = listAnnotations(workspaceRoot, withSessionScope(annotationFilterFromArgs(a), a, getActiveAgent().sessionKey));
        await captureAnnotationExportNote(records);
        return { markdown: annotationsToMarkdown(records) };
      },
      // ARTIFACT-RECORDS (0.4.15) — durable Artifact Records: a workflow output a
      // chat produces or reviews (design note / sketch / HTML prototype / markdown
      // report / verification summary / review export), with links back to the
      // requirement / task / session / memory it relates to. Thin wrappers over the
      // CLI's artifactStore (already unit-tested) so the desktop panel and the
      // terminal CLI share the same artifacts.json. Enum inputs are guard-validated
      // here so a bad kind/status/format is rejected, not silently written.
      'artifact-list': (a) => listArtifacts(workspaceRoot, withSessionScope(artifactFilterFromArgs(a), a, getActiveAgent().sessionKey)),
      'artifact-create': async (a) => {
        if (!isArtifactKind(a.kind)) return { error: `Unknown artifact kind "${String(a.kind)}".` };
        const title = String(a.title ?? '').trim();
        if (!title) return { error: 'Artifact title must be a non-empty string.' };
        if (a.status !== undefined && !isArtifactStatus(a.status)) return { error: `Unknown artifact status "${String(a.status)}".` };
        if (a.format !== undefined && !isArtifactFormat(a.format)) return { error: `Unknown artifact format "${String(a.format)}".` };
        const input: CreateArtifactInput = { kind: a.kind, title, sessionKey: getActiveAgent()?.sessionKey };
        if (isArtifactStatus(a.status)) input.status = a.status;
        if (isArtifactFormat(a.format)) input.format = a.format;
        if (typeof a.path === 'string' && a.path.trim()) input.path = a.path.trim();
        if (typeof a.content === 'string' && a.content.length) input.content = a.content;
        if (typeof a.summary === 'string' && a.summary.trim()) input.summary = a.summary;
        if (typeof a.requirementId === 'string' && a.requirementId) input.requirementId = a.requirementId;
        if (typeof a.taskId === 'string' && a.taskId) input.taskId = a.taskId;
        try {
          const created = createArtifact(workspaceRoot, input);
          await captureArtifactNote(created, 'created');
          return getArtifact(workspaceRoot, created.id) ?? created;
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      'artifact-update': async (a) => {
        const id = String(a.id ?? '');
        const patch: ArtifactPatch = {};
        let change = '';
        if (a.status !== undefined) {
          if (!isArtifactStatus(a.status)) return { error: `Unknown artifact status "${String(a.status)}".` };
          patch.status = a.status;
          change = `status → ${a.status}`;
        }
        if (a.summary !== undefined) {
          if (typeof a.summary !== 'string') return { error: 'Artifact summary must be a string.' };
          patch.summary = a.summary;
          change = change ? `${change}; summary updated` : 'summary updated';
        }
        const updated = updateArtifact(workspaceRoot, id, patch);
        if (!updated) return { error: `No artifact "${id}".` };
        if (change) await captureArtifactNote(updated, change);
        return getArtifact(workspaceRoot, updated.id) ?? updated;
      },
      // Resolve an artifact's content for the Preview area: a file-backed record
      // (`path`) is read through the SAME safe workspace file-read helper the
      // editor/file panel uses (readWorkspaceEntry — escape/symlink/size guards),
      // so the preview can never read outside the workspace; an inline record
      // returns its stored `content`.
      'artifact-read': (a) => {
        const id = String(a.id ?? '');
        const rec = getArtifact(workspaceRoot, id);
        if (!rec) return { error: `No artifact "${id}".` };
        if (rec.path) {
          const entry = readWorkspaceEntry(workspaceRoot, rec.path);
          if (entry.error) return { id, error: entry.error };
          if (entry.binary) return { id, error: 'Artifact file is binary — open it externally.' };
          return { id, content: entry.content, truncated: entry.truncated };
        }
        return { id, content: rec.content ?? '' };
      },
      // §12 WRITE-WORKSPACE — save edited artifact content back to its source. A
      // file-backed artifact (`path`) is written through the SAME safe workspace
      // write the editor uses (writeWorkspaceEntry — escape/symlink guards); an
      // inline artifact updates its stored `content`. Either way bumps updatedAt.
      'artifact-save': async (a) => {
        const id = String(a.id ?? '');
        const content = typeof a.content === 'string' ? a.content : null;
        if (content === null) return { error: 'Artifact content must be a string.' };
        const rec = getArtifact(workspaceRoot, id);
        if (!rec) return { error: `No artifact "${id}".` };
        if (rec.path) {
          const res = writeWorkspaceEntry(workspaceRoot, rec.path, content);
          if (!res.ok) return { id, error: res.error ?? 'write failed', conflict: res.conflict };
          fileListCache.invalidate(workspaceRoot);
          const updated = updateArtifact(workspaceRoot, id, {}); // bump updatedAt so the preview re-resolves
          await captureArtifactNote(updated ?? rec, 'saved to workspace');
          return { id, ok: true, path: rec.path };
        }
        const updated = updateArtifact(workspaceRoot, id, { content }, { editedBy: 'user', note: 'edited in desktop' });
        if (!updated) return { error: `No artifact "${id}".` };
        await captureArtifactNote(updated, 'content saved');
        return { id, ok: true };
      },
      // §AV-1 — restore a prior version's content as a NEW version (append-only).
      // For a file-backed artifact whose content lives on disk, also writes the
      // restored content back through the same safe workspace write.
      'artifact-revert': async (a) => {
        const id = String(a.id ?? '');
        const v = Number(a.version);
        if (!Number.isInteger(v)) return { error: 'version must be an integer.' };
        const updated = revertArtifact(workspaceRoot, id, v, { editedBy: 'user' });
        if (!updated) return { error: `No artifact "${id}" or version v${v}.` };
        if (updated.path && typeof updated.content === 'string') {
          const res = writeWorkspaceEntry(workspaceRoot, updated.path, updated.content);
          if (res.ok) fileListCache.invalidate(workspaceRoot);
        }
        await captureArtifactNote(updated, `reverted to v${v}`);
        return getArtifact(workspaceRoot, updated.id) ?? updated;
      },
      // T12 / Review v2 — local AI review of the working tree. Gathers the diff,
      // runs ONE ephemeral review turn in an ISOLATED review: session (filtered
      // from the session picker — never pollutes the user's chats), parses
      // structured findings into a ReviewRun keyed by the diff hash, and persists
      // it (reviewStore, shared with the CLI). Returns the run (+ files count for
      // the panel). Real LLM required; the parser/model/gate are unit-tested.
      'review-diff': async () => runReviewTask(getActiveAgent().sessionKey),
      'review-rerun': async () => runReviewTask(getActiveAgent().sessionKey),
      // Lightweight: the gate + current run for the diff on disk right now. Marks
      // a prior run stale if the working diff changed since it ran.
      'review-current': async () => reviewSnapshot(),
      'review-status': async () => { const s = await reviewSnapshot(); return { status: s.gate.status, blocked: s.gate.blocked, reason: s.gate.reason }; },
      'review-gate': async () => reviewSnapshot(),
      'review-dismiss-finding': (a) => ({ ok: !!updateReviewFinding(workspaceRoot, String(a.id ?? ''), 'dismissed', isoNow()) }),
      'review-resolve-finding': (a) => ({ ok: !!updateReviewFinding(workspaceRoot, String(a.id ?? ''), 'fixed', isoNow()) }),
      // Generic, validated status set — covers the 0.4.15 triage states
      // (acknowledged/disputed/out-of-scope) plus the existing ones. An unknown
      // status is rejected rather than silently written.
      'review-set-finding-status': (a) => {
        const status = a.status;
        if (!isFindingStatus(status)) return { ok: false, error: `Unknown finding status "${String(status)}".` };
        return { ok: !!updateReviewFinding(workspaceRoot, String(a.id ?? ''), status, isoNow()) };
      },
      'review-apply-suggestion': async (a) => {
        // Best-effort: apply the finding's unified-diff patch with `git apply`.
        const run = getLatestReview(workspaceRoot);
        const f = run?.findings.find((x) => x.id === String(a.id ?? ''));
        if (!f?.patch) return { ok: false, error: 'This finding has no applicable patch — use "Ask agent to fix" instead.' };
        const tmp = path.join(getStateDir(workspaceRoot), `review-${Date.now().toString(36)}.patch`);
        try {
          fs.writeFileSync(tmp, f.patch.endsWith('\n') ? f.patch : f.patch + '\n');
          const check = await git(['apply', '--check', tmp], wsGit.gitRoot ?? workspaceRoot);
          await git(['apply', tmp], wsGit.gitRoot ?? workspaceRoot);
          fs.rmSync(tmp, { force: true });
          updateReviewFinding(workspaceRoot, f.id, 'applied', isoNow());
          return { ok: true };
        } catch (err) {
          try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
          return { ok: false, error: `Patch did not apply cleanly — use "Ask agent to fix". (${err instanceof Error ? err.message : err})` };
        }
      },
      // T3 — "Ask agent to fix": spawn a scoped WRITE agent for ONE finding,
      // then mark it fixed and re-run the review so the gate re-evaluates against
      // the new diff. The fixer can EDIT files (access 'write') but its
      // interaction port denies confirmations, so it can't run shell/dangerous
      // tools unprompted (fail-closed) — it just makes the minimal code edit.
      'review-fix-finding': async (a) => {
        const run = getLatestReview(workspaceRoot);
        const f = run?.findings.find((x) => x.id === String(a.id ?? ''));
        if (!f) return { ok: false, error: 'finding not found' };
        const sessionKey = getActiveAgent().sessionKey;
        const task = createBackgroundTask(workspaceRoot, {
          kind: 'review',
          title: `Fix review finding — ${f.file}`,
          sessionKey,
          status: 'running',
        });
        const fixerKey = `fix:${task.id}`;
        const created = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: fixerKey } }) ?? task;
        emitTaskEvent('created', created);
        const prompt = [
          'Fix EXACTLY this one code-review finding and nothing else. Make the minimal edit; do not touch unrelated code; do not commit.',
          `File: ${f.file}${f.line ? ` (around line ${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ''})` : ''}`,
          `Severity: ${f.severity}`,
          `Problem: ${f.summary}`,
          f.details ? `Details: ${f.details}` : '',
          f.suggestion ? `Suggested fix: ${f.suggestion}` : '',
          f.diffHunk ? `Relevant hunk:\n${f.diffHunk}` : '',
        ].filter(Boolean).join('\n');
        try {
          taskProgress(task.id, 'fixing-finding', f.file);
          const fixer = spawnTaskAgent(fixerKey, 'write');
          const noop = (): void => {};
          const cb = {
            onStatusUpdate: (text: string) => { if (text) taskProgress(task.id, 'working', text.slice(0, 80)); },
            onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop,
            onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop,
          } as never;
          await (fixer as { runTurn: (p: string, cb: unknown) => Promise<unknown> }).runTurn(prompt, cb);
          taskProgress(task.id, 'rerunning-review', 'checking the updated diff');
          updateReviewFinding(workspaceRoot, f.id, 'fixed', isoNow());
          // Re-run the review over the new working diff so the gate + findings refresh.
          const rerun = await runReview();
          const done = updateBackgroundTask(workspaceRoot, task.id, {
            status: 'completed',
            result: { findingId: f.id, files: rerun.files, findings: rerun.findings.length },
          });
          if (done) emitTaskEvent('completed', done);
          return { ok: true, findingId: f.id, files: rerun.files, run: rerun };
        } catch (err) {
          const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: `Fix agent failed: ${err instanceof Error ? err.message : err}` });
          if (failed) emitTaskEvent('failed', failed);
          return { ok: false, error: `Fix agent failed: ${err instanceof Error ? err.message : err}` };
        }
      },
      // DESK-4c — every CLI slash command, straight from the CLI's catalog.
      'commands-catalog': () => {
        // T16 — surface catalog drift at runtime (not just in tests): the desktop
        // serves the CLI's own lists, so any drift here is a real regression.
        const parity = validateCatalogParity(SLASH_COMMANDS, HELP_CATEGORIES);
        return { categories: HELP_CATEGORIES, all: [...SLASH_COMMANDS], parityValid: parity.valid, parityErrors: parity.errors };
      },
      // T14 — scheduler: read/manage the CLI scheduleStore (same schedules.json
      // the /schedule REPL command uses). Filtered to the viewed session's owner.
      'schedule-list': () => loadSchedules(workspaceRoot).filter((s) => s.owner === getActiveAgent().sessionKey),
      'schedule-add': (a) => {
        const kind = a.kind === 'once' ? 'once' : 'cron';
        const expr = String(a.expr ?? '').trim();
        const command = String(a.command ?? '').trim();
        if (!command.startsWith('/')) return { ok: false, error: 'Command must start with "/".' };
        let nextRun: string;
        if (kind === 'cron') {
          const cron = parseCron(expr);
          if (!cron) return { ok: false, error: `Invalid cron expression: "${expr}" (need 5 fields).` };
          nextRun = nextCronFire(cron, new Date()).toISOString();
        } else {
          const at = new Date(expr);
          if (Number.isNaN(at.getTime())) return { ok: false, error: `Invalid date/time: "${expr}".` };
          nextRun = at.toISOString();
        }
        const rec = addSchedule(workspaceRoot, { kind, expr, command, owner: getActiveAgent().sessionKey, nextRun, enabled: true });
        return { ok: true, schedule: rec };
      },
      'schedule-remove': (a) => ({ ok: removeSchedule(workspaceRoot, String(a.id ?? '')) }),
      'schedule-toggle': (a) => ({ ok: setScheduleEnabled(workspaceRoot, String(a.id ?? ''), a.enabled !== false), enabled: a.enabled !== false }),
      // DESK-4c — one snapshot powering the whole Settings dialog. All values
      // come from the stores the CLI itself reads/writes.
      'config-snapshot': () => {
        const fresh = loadConfig();
        setLlm(fresh.llm ?? getLlm());
        syncActiveSessionLlm(getLlm());
        const cli = (fresh as { cli?: { permissions?: { allow?: string[]; deny?: string[] }; sandbox?: 'on' | 'off'; fallbackModel?: string | null } }).cli;
        const mcpStatuses = new Map(mcpClient.getStatuses().map((s) => [s.serverId, s]));
        const providerEntries = Object.entries(fresh.providers ?? {});
        const defaultProviderMatch = matchingDefaultProvider(fresh.providers, fresh.llm);
        const defaultProviderName = defaultProviderMatch.name;
        const resolvedKnobs = resolveCliKnobs(fresh);
        const baseName = fresh.providers?.base ? 'base-config' : 'base';
        const routerRegistry = buildModelRegistry(
          { ...(fresh.providers ?? {}), ...(fresh.llm ? { [baseName]: fresh.llm } : {}) },
          {
            aliases: resolvedKnobs.router.aliases,
            chain: [...resolvedKnobs.router.chain, ...resolvedKnobs.fallbackModels, ...(fresh.llm ? [`${baseName}/${fresh.llm.model}`] : [])],
            order: resolvedKnobs.router.order,
            strategy: resolvedKnobs.router.strategy,
            passThrough: resolvedKnobs.router.passThrough,
            availableModels: resolvedKnobs.availableModels,
            enforceAvailableModels: resolvedKnobs.enforceAvailableModels,
          },
        );
        const workspacePrefs = readPreferences(workspaceRoot);
        const activeMode = resolveActiveMode(workspaceRoot, getActiveAgent().sessionKey);
        const connectorItems = listConnectors(workspaceRoot);
        return {
          model: fresh.llm?.model ?? getLlm().model,
          provider: fresh.llm?.provider ?? getLlm().provider,
          endpoint: fresh.llm?.endpoint ?? null,
          fallbackModel: cli?.fallbackModel ?? null,
          workspaceRoot,
          sandbox: cli?.sandbox ?? 'off',
          prefs: mergeSessionModePrefs(workspacePrefs as unknown as Record<string, unknown>, activeMode),
          workspacePrefs,
          sessionMode: getSessionMode(workspaceRoot, getActiveAgent().sessionKey),
          modeScope: 'session',
          cli: scrubCliSecrets(fresh.cli),
          integrations: { github: githubIntegrationSnapshot(workspaceRoot) },
          connectors: {
            catalog: listConnectorCatalog(),
            items: connectorItems,
            documentCounts: Object.fromEntries(connectorItems.map((connector) => [connector.id, countConnectorDocuments(workspaceRoot, { connectorId: connector.id })])),
            permissionCounts: Object.fromEntries(connectorItems.map((connector) => [connector.id, countConnectorPermissions(workspaceRoot, { connectorId: connector.id })])),
            runPreviews: Object.fromEntries(connectorItems.map((connector) => [connector.id, listConnectorRuns(workspaceRoot, connector.id).slice(0, 3)])),
            documentPreviews: Object.fromEntries(connectorItems.map((connector) => [
              connector.id,
              retrieveConnectorSlimDocuments(workspaceRoot, { connectorId: connector.id, limit: 3, maxSnippetChars: 180 }),
            ])),
          },
          permissionRules: { allow: cli?.permissions?.allow ?? [], deny: cli?.permissions?.deny ?? [] },
          hooks: readHooks(workspaceRoot),
          servers: Object.entries(fresh.servers ?? {}).map(([id, cfg]) => {
            const s = mcpStatuses.get(id);
            return {
              id,
              online: s?.status === 'connected',
              identity: s?.identity ?? 'unknown', // WS9 — brainrouter | third-party | unknown (brain-vs-tools grouping)
              detail: s && s.identity !== 'unknown' ? s.identity : undefined,
              type: cfg.type,
              url: cfg.type === 'http' ? cfg.url ?? null : null,
              command: cfg.type === 'stdio' ? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ') : null,
              hasKey: !!cfg.apiKey,
              envCount: Object.keys(cfg.env ?? {}).length,
              headerCount: Object.keys(cfg.headers ?? {}).length,
            };
          }),
          activeServer: fresh.activeServer ?? null, // WS9 — which brainrouter server is the ACTIVE brain (only one)
          // §multi-provider — named providers (API KEYS MASKED, never sent to the
          // renderer) + the per-sub-agent-role model routing.
          providers: providerEntries.map(([name, p]) => ({
            name,
            provider: p.provider,
            model: p.model,
            endpoint: p.endpoint ?? null,
            hasKey: !!p.apiKey,
            models: p.models ?? [],
            cachedModels: p.cachedModels ?? [],
            cachedAt: p.cachedAt ?? null,
            apiVersion: p.apiVersion ?? null,
            free: p.free === true,
            passthroughUnknown: p.passthroughUnknown === true,
          })),
          routerCatalog: {
            enabled: resolvedKnobs.router.enabled,
            primaryChain: resolvedKnobs.router.chain,
            canonical: aggregateCatalog(routerRegistry, { prefix: 'canonical' }),
            bare: aggregateCatalog(routerRegistry, { prefix: 'bare' }),
            aliases: aggregateCatalog(routerRegistry, { prefix: 'alias' }),
          },
          routerStatus: getRouterPolicy().status(),
          routerServe: routerServeStatus(),
          defaultProviderName,
          defaultProviderModelMatches: defaultProviderMatch.modelMatches,
          agentModels: Object.entries(fresh.agentModels ?? {}).map(([role, a]) => ({ role, provider: a.provider ?? null, model: a.model ?? null })),
          // The known-provider catalog (same list the CLI wizard picks from) so the
          // main provider is CHOSEN, not hand-typed — picking one prefills its
          // OpenAI-compatible endpoint. Sourced from config/providers.json.
          providerCatalog: PROVIDER_CATALOG.map((p) => ({ id: p.id, label: p.label, endpoint: p.endpoint, local: p.local })),
          // §settings-completeness — the raw cli.* block so the Advanced section can
          // show current knob values (no key here; values are config, not secrets).
          cliKnobs: scrubCliSecrets(cli),
          cliSchema: CLI_CONFIG_SCHEMA,
          // MC-B1 — trigger signing secrets are write-only: expose only whether
          // each is currently set so the Automations panel can show "configured"
          // without the value ever reaching the renderer. Read from the RAW cli.
          triggerSecretsSet: (() => {
            const t = ((cli as Record<string, unknown> | undefined)?.triggers ?? {}) as Record<string, unknown>;
            const isSet = (k: string): boolean => typeof t[k] === 'string' && (t[k] as string).length > 0;
            return { github: isSet('githubSecret'), slack: isSet('slackSigningSecret'), gitlab: isSet('gitlabSecret'), jira: isSet('jiraSecret') };
          })(),
          routerSecretsSet: (() => {
            const r = ((cli as Record<string, unknown> | undefined)?.router ?? {}) as Record<string, unknown>;
            return { serveKey: typeof r.serveKey === 'string' && r.serveKey.length > 0 };
          })(),
          // MC-DESK Batch 2 — live runtime/automation surfaces for the Settings
          // monitor cards. Each read is fail-soft: a missing store never breaks
          // the whole snapshot. These call node-fs core APIs (host-side only).
          runtimes: (() => {
            try {
              return listRuntimeRecords(workspaceRoot).map((r) => ({
                id: r.id, backend: r.backend, status: r.status, pid: r.pid ?? null,
                worktree: r.worktree?.worktreeRoot ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt,
              }));
            } catch { return []; }
          })(),
          runtimeArchives: (() => {
            try {
              return listArchives().slice(0, 50).map((a) => ({
                id: a.id, branch: a.branch, baseCommit: a.baseCommit.slice(0, 10), bytes: a.bytes,
                changedFiles: a.changedFiles, status: a.status, createdAt: a.createdAt,
                note: a.note ?? null, workspaceRoot: a.workspaceRoot,
              }));
            } catch { return []; }
          })(),
          runtimePreviewsLive: (() => {
            try {
              return listRuntimePreviewPorts(workspaceRoot).map((p) => ({ runtimeId: p.runtimeId, name: p.name, url: p.url, port: p.port }));
            } catch { return []; }
          })(),
          automationRules: (() => {
            try {
              return listAutomationRules(workspaceRoot).map((r) => ({
                id: r.id, name: r.name, on: r.on, when: r.when, do: r.do, enabled: r.enabled, sourcePath: r.sourcePath,
              }));
            } catch { return []; }
          })(),
          triggerServe: triggerServeStatus(),
          // EXTENSIONS — discovered extensions + workspace trust, for the
          // Settings → Extensions section (toggle/trust refresh this snapshot).
          extensions: {
            trusted: isWorkspaceTrusted(workspaceRoot),
            items: listExtensions(workspaceRoot).map((e) => ({
              name: e.name, version: e.version, source: e.source, description: e.description,
              contributes: e.contributes, enabled: isExtensionEnabled(e.name),
              blocked: e.source === 'workspace' && !isWorkspaceTrusted(workspaceRoot),
            })),
          },
        };
      },
      'usage-breakdown': () => buildUsageBreakdown({ parent: getActiveAgent().sessionUsage, children: [], offload: undefined, prefixStability: getActiveAgent().getPrefixStability() }),
      // WS10 — persistent cross-session usage history (day-bucketed), for the
      // contributions-style heatmap + range totals in the Usage panel.
      'usage-history': (a) => {
        const days = typeof a.days === 'number' && a.days > 0 ? Math.floor(a.days) : 30;
        const records = readUsageHistory(days, Date.now());
        return { days: records, total: totalUsage(records) };
      },
      // DESK-5r — context fill for the composer ring. `used` is the agent's
      // authoritative last prompt_tokens (the live context size, updated after
      // every LLM call within a turn). The ring fills toward the AUTO-COMPACT
      // threshold — the point where BrainRouter summarizes old history and the
      // context RESETS — because that's the operative limit the user feels (the
      // raw model window is shown too, for context). After a compaction the
      // agent clears lastSeenPromptTokens, so `used` drops and the ring resets.
      'context-usage': () => {
        // getCurrentContextTokens() = last authoritative prompt_tokens OR a
        // content estimate of the CURRENT chatHistory — so right after a
        // session switch (history loaded, no LLM call yet) it reflects THIS
        // session's size instead of the previous one's stale count.
        const a = getActiveAgent() as unknown as { getCurrentContextTokens?: () => number; lastSeenPromptTokens?: number };
        // DESK-6t — with LAZY history, a freshly-resumed chat hasn't loaded its
        // transcript into the agent yet, so the agent estimate would read ~0.
        // Fall back to the resumed transcript's token estimate (from the cache
        // populated on resume) so the ring isn't wrong while you're browsing.
        const agentTokens = Number(a.getCurrentContextTokens?.() ?? a.lastSeenPromptTokens ?? 0);
        // OOM-safe ring estimate: a lazily-resumed chat hasn't loaded history into
        // the agent yet, so approximate context from the transcript's BYTE SIZE
        // (~4 bytes/token) — O(1), no content read, no cache dependency. The
        // agent's authoritative prompt_tokens takes over once a turn runs.
        const sizeEstimate = Math.round(transcriptSizeBytes(workspaceRoot, getActiveAgent().sessionKey) / 4);
        // Use the transcript-byte estimate ONLY as a fallback while the agent
        // hasn't loaded history yet (lazy resume → agentTokens ≈ 0). It must NOT
        // be a Math.max floor: the transcript file is append-only and never
        // shrinks on compaction, so a max() would permanently pin the ring at
        // 100% once the file grows past the window — auto-compact could never
        // free it. Once a turn has run, agentTokens (authoritative prompt_tokens
        // or a content estimate of the COMPACTED history) is the truth.
        const used = agentTokens > 0 ? agentTokens : sizeEstimate;
        const model = getActiveAgent().getModel?.() ?? getLlm().model;
        const window = contextWindowForBudget(model);
        const compactAt = getCliKnobs().autoCompactTokens || 80_000;
        const limit = compactAt > 0 ? compactAt : window;
        return { used, window, compactAt, limit, pct: limit > 0 ? Math.min(1, used / limit) : 0 };
      },
      // Structured per-session plan for the renderer's Plan panel + the context
      // surfaces. Read fresh from THIS session's durable plan so switching chats
      // shows the right plan (a new chat → empty) instead of the last live one.
      // EXTENSIONS — discovered extensions + their state for the Settings panel.
      'extensions': () => {
        const trusted = isWorkspaceTrusted(workspaceRoot);
        const contrib = extensionContributionSummary();
        return {
          workspaceRoot,
          trusted,
          contributions: contrib,
          items: listExtensions(workspaceRoot).map((e) => ({
            name: e.name,
            version: e.version,
            source: e.source,
            description: e.description,
            contributes: e.contributes,
            enabled: isExtensionEnabled(e.name),
            blocked: e.source === 'workspace' && !trusted,
          })),
        };
      },
      'plan-state': () => {
        const p = readPlan(workspaceRoot, getActiveAgent().sessionKey);
        return { items: p.items, explanation: p.explanation };
      },
      // GOAL-BANNER — the structured active goal for THIS session, so the chat
      // can pin it with status + controls (vs the plain-text /goal command out).
      'goal-state': () => readGoal(workspaceRoot, getActiveAgent().sessionKey) ?? null,
      // Edit the active goal's text in place (no re-kickoff) for the banner's
      // inline editor. Returns the updated goal so the banner refreshes.
      'action:goal-edit': (args) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { ok: false, error: 'Goal text cannot be empty.' };
        try {
          const g = editGoal(workspaceRoot, getActiveAgent().sessionKey, { text });
          return g ? { ok: true, goal: g } : { ok: false, error: 'No active goal to edit.' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      // §goal-autonomy — the desktop's goal loop driver. The renderer calls this
      // after each turn completes; it applies the SAME decision the CLI Ink loop
      // uses (`decideGoalContinuation`) for the active session + ticks the
      // iteration / transitions the goal, and returns the next move:
      //  - { action: 'continue', followUp } → the renderer fires a HIDDEN turn
      //  - { action: 'usage_limited' | 'halt' | 'complete' | 'blocked', notice } → a status line
      //  - { action: 'none' } → no goal / nothing to do
      'goal-continuation': () => {
        const sk = getActiveAgent().sessionKey;
        const goal = readGoal(workspaceRoot, sk);
        if (!goal) return { action: 'none' };
        const lastTurnToolCalls = (getActiveAgent() as { lastTurnToolCalls?: number }).lastTurnToolCalls ?? 0;
        const lastGoalTransition = (getActiveAgent() as { lastGoalTransition?: 'complete' | 'blocked' }).lastGoalTransition;
        // Terminal states the model itself reached this turn.
        if (lastGoalTransition === 'complete' || goal.status === 'complete') {
          goalStrikes.delete(sk);
          return { action: 'complete', notice: `🎯 Goal achieved — ${goal.blockedReason ?? 'evidence on record.'}` };
        }
        if (lastGoalTransition === 'blocked' || goal.status === 'blocked') {
          goalStrikes.delete(sk);
          return { action: 'blocked', notice: `🚧 Goal blocked: ${goal.blockedReason ?? '(no reason)'} — resolve it, then /goal resume.` };
        }
        if (goal.status !== 'active') return { action: 'none' };
        let strikes = goalStrikes.get(sk) ?? 0;
        if (lastTurnToolCalls > 0) strikes = 0;
        const decision = decideGoalContinuation(goal, { lastTurnToolCalls, lastGoalTransition, noToolStrikes: strikes });
        if (decision.kind === 'continue') {
          tickGoalIteration(workspaceRoot, sk);
          strikes = decision.corrective ? strikes + 1 : 0;
          goalStrikes.set(sk, strikes);
          const base = buildGoalContinuationPrompt(goal, '', '');
          const followUp = decision.corrective ? `${base}\n\n${goalCorrectiveNotice()}` : base;
          return { action: 'continue', followUp, iteration: decision.nextIteration, cap: formatBudget(goal.budget.maxIterations), corrective: decision.corrective };
        }
        if (decision.kind === 'usage-limited') {
          usageLimitGoal(workspaceRoot, sk, decision.reason);
          return { action: 'usage_limited', notice: `⏸ Goal hit its budget: ${decision.reason} Raise it with /goal budget <n>, then /goal resume.` };
        }
        if (decision.kind === 'halt-prose') {
          return { action: 'halt', notice: '⏸ Goal paused: two prose-only turns in a row — send a message to nudge it, or /goal clear.' };
        }
        return { action: 'none' };
      },
      // §7 PLAN REVIEW — this session's plan decision log (oldest-first append
      // order; the renderer reverses + diffs for display). Doubles as the plan's
      // version history since each decision snapshots the plan at that moment.
      'plan-history': () => readPlanHistory(workspaceRoot, getActiveAgent().sessionKey),
      // Record an approval / changes-requested decision against THIS session's
      // current plan (snapshotting it), then capture a best-effort memory note and
      // link it back — exactly like the CLI's /plan approve·request-changes.
      'plan-record-decision': async (a) => {
        const verdict = a.verdict as PlanVerdict;
        if (verdict !== 'approved' && verdict !== 'changes-requested') return { error: `Unknown plan verdict "${String(a.verdict)}".` };
        const feedback = typeof a.feedback === 'string' ? a.feedback.trim() : '';
        // A revision needs SOMETHING to act on: a top-level note OR at least one
        // open per-step comment (annotation). Comment-only revisions are allowed.
        const openPlanNotes = verdict === 'changes-requested'
          ? listAnnotations(workspaceRoot, { targetKind: 'plan', sessionKey: getActiveAgent().sessionKey })
              .filter((n) => n.status !== 'resolved' && n.status !== 'rejected' && n.status !== 'ignored').length
          : 0;
        if (verdict === 'changes-requested' && !feedback && openPlanNotes === 0) {
          return { error: 'Add a note, or comment on a plan step, before requesting changes.' };
        }
        const cur = readPlan(workspaceRoot, getActiveAgent().sessionKey);
        if (cur.items.length === 0) return { error: 'There is no plan to review in this session yet.' };
        const decision = recordPlanDecision(workspaceRoot, getActiveAgent().sessionKey, {
          verdict, feedback: feedback || undefined, planSnapshot: cur.items, explanation: cur.explanation, requirementId: cur.requirementId,
        });
        try {
          const memoryId = await emitAgentEvent(
            { mcpClient, sessionKey: getActiveAgent().sessionKey },
            {
              kind: 'agent_output',
              summary: `Plan ${decision.verdict} (${decision.id}) — ${decision.planSnapshot.length} item(s)${decision.feedback ? `: ${decision.feedback}` : ''}`,
              payload: { planDecisionId: decision.id, verdict: decision.verdict, feedback: decision.feedback, requirementId: decision.requirementId, itemCount: decision.planSnapshot.length },
            },
          );
          if (memoryId) linkPlanDecision(workspaceRoot, getActiveAgent().sessionKey, decision.id, memoryId);
        } catch { /* advisory — never break the action */ }
        // §1 — requesting changes launches a real, visible background revision
        // task. The decision is already saved, so a task-launch failure still
        // returns ok (the renderer keeps the feedback draft + surfaces the error).
        if (verdict === 'changes-requested') {
          try {
            const task = runPlanRevisionTask(getActiveAgent().sessionKey, decision, feedback);
            return { ok: true, decision, task: taskEventView(task) };
          } catch (err) {
            return { ok: true, decision, taskError: err instanceof Error ? err.message : String(err) };
          }
        }
        return { ok: true, decision };
      },
      'search-transcript': (args) => {
        const query = typeof args.q === 'string' ? args.q : '';
        // OOM-safe: search a bounded recent window (50 capped results anyway).
        return searchTranscript(readTranscriptTail(workspaceRoot, getActiveAgent().sessionKey, 5000), query, { limit: 50 })
          .map((m) => ({ index: (m as { index?: number }).index ?? 0, role: (m as { role?: string }).role ?? '?', snippet: (m as { snippet?: string }).snippet ?? '' }));
      },
      'chapters': () => listChapters(readTranscriptTail(workspaceRoot, getActiveAgent().sessionKey, 2000)),
      // DESK-5p — render a resumed session's FULL history: user/assistant prose
      // verbatim AND the real tool calls (name + arg-derived summary + output
      // preview + ok), reconstructed from the persisted OpenAI-format entries
      // (assistant `tool_calls` request the call; the `tool` result message
      // carries name + content + isError). Consecutive tool activity collapses
      // into one tool-group row, exactly like the live stream — so the resumed
      // view shows the same expandable tool cards instead of a bare count.
      'transcript': (args) => {
        const key = typeof args.sessionKey === 'string' ? args.sessionKey : getActiveAgent().sessionKey;
        // OOM-safe: bounded TAIL read (not the full-history cache) — the UI only
        // renders the last 400 rows, so ~1200 recent entries is plenty and the
        // host never allocates a multi-megabyte transcript for rendering.
        const entries = readTranscriptTail(workspaceRoot, key, 1200) as Parameters<typeof reconstructTranscriptRows>[0];
        return { sessionKey: key, rows: reconstructTranscriptRows(entries).slice(-400) };
      },
      // DESK-5w — the conversation of a background task (a delegated child agent
      // OR a worker), reconstructed like a normal chat. The renderer opens this
      // read-only from the Background tasks panel, so you can see exactly what a
      // subagent is doing and what it has said/done so far.
      'task-transcript': (args) => {
        const kind = typeof args.kind === 'string' ? args.kind : 'agent';
        const id = typeof args.id === 'string' ? args.id : '';
        const parent = typeof args.parentSessionKey === 'string' ? args.parentSessionKey : '';
        if (kind === 'worker') {
          const meta = readWorkerMeta(workspaceRoot, id);
          const raw = readWorkerTranscript(workspaceRoot, id, 400) as Array<Record<string, unknown>>;
          return { id, kind, role: meta?.role, goal: meta?.goal, status: meta?.status, rows: workerEventsToRows(raw) };
        }
        // §1/§2/§3 — a DURABLE task (plan revision / review / verification). The
        // task agent ran under its own internal session key (carried in the
        // task's transcript ref as parentSessionKey); reconstruct that turn's
        // transcript exactly like a chat so the user sees what the task did.
        if (kind === 'task') {
          const taskRec = getBackgroundTask(workspaceRoot, id);
          const taskKey = parent || taskRec?.transcript?.parentSessionKey || '';
          const entries = (taskKey ? readTranscriptTail(workspaceRoot, taskKey, 1200) : []) as Parameters<typeof reconstructTranscriptRows>[0];
          const rows = reconstructTranscriptRows(entries).slice(-400);
          return { id, kind, role: taskRec?.kind, goal: taskRec?.title, status: taskRec?.status, rows };
        }
        // Child agent: its history lives at childSessionKey(parent, id); an
        // isolated-worktree child persists under its own childWorkspaceRoot.
        const session = listSessions(workspaceRoot).find((s) => s.id === id);
        const childKey = parent ? childSessionKey(parent, id) : id;
        const readRoot = session?.childWorkspaceRoot ?? workspaceRoot;
        // OOM-safe: bounded tail (the task view renders the last 400 rows).
        const entries = readTranscriptTail(readRoot, childKey, 1200) as Parameters<typeof reconstructTranscriptRows>[0];
        return { id, kind, role: session?.role, goal: session?.prompt, status: session?.status, rows: reconstructTranscriptRows(entries).slice(-400) };
      },
      // DESK-6w — a workflow run's full breakdown for workflow-style
      // card: each phase with its spawned child AGENTS resolved to live stats
      // (role/label/status + tokens, tool calls, wall-clock). Step-based runs
      // (no phases) fall back to a flat step list.
      'workflow-detail': (args) => {
        const slug = typeof args.slug === 'string' ? args.slug : '';
        const run = readRun(workspaceRoot, slug);
        if (!run) return null;
        const byId = new Map(listSessions(workspaceRoot).map((s) => [s.id, s]));
        const resolveAgents = (childIds: string[]) => childIds.map((id) => {
          const s = byId.get(id);
          const tokens = (s?.usage?.promptTokens ?? 0) + (s?.usage?.completionTokens ?? 0);
          const started = s?.startedAt ? new Date(s.startedAt).getTime() : 0;
          const ended = s?.completedAt ? new Date(s.completedAt).getTime() : Date.now();
          const ms = s?.usage?.wallClockMs ?? (started ? Math.max(0, ended - started) : 0);
          return { id, label: s?.label || s?.role || id, role: s?.role ?? '?', status: s?.status ?? 'unknown', tokens, tools: s?.usage?.calls ?? 0, ms };
        });
        const phases = (run.phases ?? []).map((p) => ({ id: p.id, title: p.title, status: p.status, agents: resolveAgents(p.childIds ?? []) }));
        const steps = (!run.phases || run.phases.length === 0) ? run.steps.map((st) => ({ id: st.id, title: st.title, status: st.status })) : [];
        let totalAgents = 0, totalTokens = 0;
        for (const p of phases) { totalAgents += p.agents.length; for (const a of p.agents) totalTokens += a.tokens; }
        return { slug: run.slug, kind: run.kind, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt, phases, steps, totalAgents, totalTokens };
      },
      'export-chat': (args) => {
        const format = args.format === 'json' ? 'json' : 'md';
        const entries = loadTranscript(workspaceRoot, getActiveAgent().sessionKey);
        const exportedAt = new Date().toISOString();
        const meta = { sessionKey: getActiveAgent().sessionKey, exportedAt };
        return {
          filename: exportFileName(getActiveAgent().sessionKey, format, exportedAt),
          content: format === 'json' ? exportTranscriptJson(entries, meta) : exportTranscriptMarkdown(entries, meta),
        };
      },
      // DESK-4e — content search (the Files panel's "?text" mode, observed).
      'search-content': async (args) => {
        const query = typeof args.q === 'string' ? args.q : '';
        if (!query.trim()) return [];
        const out = await git(['grep', '-n', '-I', '--max-count', '3', '--', query], workspaceRoot, { timeout: 8_000, maxBuffer: 4_000_000 });
        return out.split('\n').filter(Boolean).slice(0, 50).map((line) => {
          const [file, ln, ...rest] = line.split(':');
          return { file, line: Number(ln) || 0, snippet: rest.join(':').trim().slice(0, 160) };
        });
      },
      // DESK-4e — "Always allow" on inline approval cards persists a glob rule
      // into the SAME cli.permissions store the CLI's policy gate evaluates.
      'action:allow-rule': (args) => {
        const rule = typeof args.rule === 'string' ? args.rule.trim() : '';
        if (!rule) throw new Error('Empty permission rule.');
        const fresh = loadConfig() as { cli?: { permissions?: { allow?: string[]; deny?: string[] } } };
        fresh.cli = fresh.cli ?? {};
        fresh.cli.permissions = fresh.cli.permissions ?? {};
        const allow = (fresh.cli.permissions.allow = fresh.cli.permissions.allow ?? []);
        if (!allow.includes(rule)) allow.push(rule);
        saveConfig(fresh as never);
        return { ok: true, rule };
      },
      // T7 — full permission-rules editor (add/remove on allow OR deny), via the
      // pure tested applyRuleEdit. Shared config.json — the CLI gate reads it too.
      'action:rule-edit': (args) => {
        const op = args.op === 'remove' ? 'remove' : 'add';
        const kind = args.kind === 'deny' ? 'deny' : 'allow';
        const rule = typeof args.rule === 'string' ? args.rule : '';
        if (op === 'add' && !rule.trim()) throw new Error('Empty permission rule.');
        const fresh = loadConfig() as { cli?: { permissions?: { allow?: string[]; deny?: string[] } } };
        fresh.cli = fresh.cli ?? {};
        fresh.cli.permissions = applyRuleEdit(fresh.cli.permissions, op, kind, rule);
        saveConfig(fresh as never);
        return { ok: true, permissions: fresh.cli.permissions };
      },
      // DESK-4e — user-typed terminal commands (the Terminal panel's input
      // row). Equivalent to the CLI's `!` shell escape: the USER runs it, so
      // no approval gate; cwd is the workspace.
      'action:term-exec': (args) => {
        const cmd = typeof args.cmd === 'string' ? args.cmd : '';
        if (!cmd.trim()) return { out: '', code: 0 };
        return new Promise((resolve) => {
          exec(cmd, { cwd: workspaceRoot, timeout: 20_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
            fileListCache.invalidate(workspaceRoot);
            resolve({
              out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20_000),
              code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code : err ? 1 : 0,
            });
          });
        });
      },
      // T5 — save an editor buffer. A USER edit, so no approval gate (same posture
      // as action:term-exec). writeWorkspaceEntry enforces escape/symlink/stale
      // guards and returns {ok}|{conflict}|{error}; the renderer surfaces it.
      'action:file-save': (args) => {
        const result = writeWorkspaceEntry(
          workspaceRoot,
          typeof args.path === 'string' ? args.path : '',
          typeof args.content === 'string' ? args.content : '',
          { expectedMtimeMs: typeof args.expectedMtimeMs === 'number' ? args.expectedMtimeMs : undefined },
        );
        if (result.ok) fileListCache.invalidate(workspaceRoot);
        return result;
      },
      // DESK-5 — the command bridge. Each case mirrors the REPL command's
      // behavior using the CLI's own store modules; output is plain lines the
      // renderer shows as a command-output block in the chat.
      'command:dispatch': async (args) => {
        const cmd = String(args.cmd ?? '');
        const rest = typeof args.args === 'string' ? args.args.trim() : '';
        switch (cmd) {
          case 'goal': {
            const sk = getActiveAgent().sessionKey;
            if (rest === 'clear') { clearGoal(workspaceRoot, sk); goalStrikes.delete(sk); return { lines: ['Goal cleared.'] }; }
            if (rest === 'pause') { const g = pauseGoal(workspaceRoot, sk); return { lines: g ? ['Goal paused — /goal resume to continue.'] : ['No active goal to pause.'] }; }
            if (rest === 'resume') {
              const g = resumeGoal(workspaceRoot, sk);
              if (!g) return { lines: ['No goal to resume.'] };
              goalStrikes.delete(sk);
              // §goal-autonomy — resuming kicks off a turn; the loop takes over.
              return { lines: [`Goal resumed: ${g.text}`, `status: ${g.status}`], startTurn: buildGoalKickoffPrompt(g, 'resume') };
            }
            if (rest && rest !== 'show') {
              // Set a NEW goal and KICK OFF the autonomy loop (the renderer fires
              // the returned startTurn; the goal-continuation query keeps it going).
              const g = setGoal(workspaceRoot, rest, sk, { force: true });
              goalStrikes.delete(sk);
              // WS4 — record the goal text as the canonical (untagged) first user
              // entry immediately, so the session lists in the sidebar and titles
              // by the goal even before the (hidden, name:'goal') kickoff turn runs.
              try { appendTranscriptEntry(workspaceRoot, sk, { role: 'user', content: g.text }); } catch { /* listing is best-effort */ }
              // Seed a visible starter plan so the Plan panel populates the
              // instant the goal is set (instead of waiting on the model to call
              // update_plan). The kickoff prompt tells the agent to replace it.
              try {
                updatePlan(workspaceRoot, { plan: [{ step: g.text.slice(0, 200), status: 'in_progress' }], explanation: 'Goal kickoff — the agent will break this down via update_plan.' }, sk);
              } catch { /* plan seed is best-effort */ }
              return { lines: [`Goal set: ${g.text}`, `status: ${g.status} — working on it…`], startTurn: buildGoalKickoffPrompt(g, 'start') };
            }
            const g = readGoal(workspaceRoot, sk);
            return { lines: g ? [`Goal: ${g.text}`, `status: ${g.status} · iteration ${g.budget.iterationsUsed}/${formatBudget(g.budget.maxIterations)}`] : ['No active goal.', 'Usage: /goal <text> · /goal pause · /goal resume · /goal clear'] };
          }
          case 'plan': {
            const text = formatPlan(readPlan(workspaceRoot, getActiveAgent().sessionKey));
            return { lines: text.trim() ? text.split('\n') : ['No plan yet.'] };
          }
          case 'workers': {
            const ws = listWorkers(workspaceRoot);
            if (rest.startsWith('info ')) {
              const id = rest.slice(5).trim();
              const summary = readWorkerSummary(workspaceRoot, id);
              return { lines: summary ? summary.split('\n').slice(0, 40) : [`No summary for worker ${id}.`] };
            }
            return {
              lines: ws.length
                ? ws.slice(0, 20).map((w) => `${w.id} · ${(w as { status?: string }).status ?? '?'} · ${((w as { task?: string }).task ?? '').slice(0, 70)}`)
                : ['No workers in this workspace.'],
            };
          }
          case 'ps': {
            const tasks = collectRunningTasks(workspaceRoot) as Array<{ kind: string; id: string; label: string }>;
            return { lines: tasks.length ? tasks.map((t) => `${t.kind} · ${t.id} · ${t.label}`) : ['Nothing running.'] };
          }
          case 'tools': {
            try {
              const res = await mcpClient.listTools() as { tools?: Array<{ name?: string }> };
              const names = (res.tools ?? []).map((t) => t.name).filter(Boolean) as string[];
              return { lines: names.length ? [`${names.length} MCP tools:`, ...names.slice(0, 60)] : ['No MCP tools (offline mode — local tools only).'] };
            } catch { return { lines: ['No MCP tools (offline mode — local tools only).'] }; }
          }
          case 'status': {
            const st = mcpClient.getStatuses();
            return {
              lines: [
                `model: ${getActiveAgent().getModel?.() ?? getLlm().model} (${getLlm().provider})`,
                `workspace: ${workspaceRoot}`,
                `session: ${getActiveAgent().sessionKey}`,
                ...st.map((x) => `mcp ${x.serverId}: ${x.status}${x.identity !== 'unknown' ? ` (${x.identity})` : ''}`),
                st.length === 0 ? 'mcp: no servers configured' : '',
              ].filter(Boolean),
            };
          }
          case 'briefing': {
            const a = getActiveAgent() as unknown as { lastBriefingSources?: string[]; lastBriefingDetails?: Record<string, unknown> };
            const sources = a.lastBriefingSources ?? [];
            const details = a.lastBriefingDetails ?? {};
            if (!sources.length && !Object.keys(details).length) return { lines: ['No briefing yet — run a turn first.'] };
            return {
              lines: [
                sources.length ? `Sources queried: ${sources.join(', ')}` : 'Sources queried: —',
                ...Object.entries(details).slice(0, 12).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v)?.slice(0, 120)}`),
              ],
            };
          }
          case 'memory':
          case 'recall': {
            if (!rest) return { lines: [`Usage: /${cmd} <query>`] };
            try {
              const result = await mcpClient.callTool(cmd === 'memory' ? 'memory_search' : 'cognitive_recall', { query: rest });
              const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
              return { lines: text.split('\n').slice(0, 50) };
            } catch (err) {
              return { lines: [`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`, 'Is the BrainRouter MCP server connected?'] };
            }
          }
          default:
            throw new Error(`Unknown bridge command "${cmd}".`);
        }
      },
      // DESK-5 — provider/endpoint/key editor writes the shared config.json.
      // Only the fields the user actually typed are touched; the key is never
      // echoed back (config-snapshot already omits it).
      'action:set-llm': (args) => {
        const fresh = loadConfig();
        const llmCfg = (fresh.llm = fresh.llm ?? { provider: 'openai', apiKey: '', model: '' });
        if (typeof args.provider === 'string' && args.provider.trim()) llmCfg.provider = args.provider.trim();
        if (typeof args.model === 'string' && args.model.trim()) llmCfg.model = args.model.trim();
        if (typeof args.endpoint === 'string') llmCfg.endpoint = args.endpoint.trim() || PROVIDER_CATALOG.find((p) => p.id === llmCfg.provider)?.endpoint || undefined;
        if (typeof args.apiKey === 'string' && args.apiKey.trim()) llmCfg.apiKey = args.apiKey.trim();
        saveConfig(fresh);
        setLlm({ ...llmCfg });
        syncActiveSessionLlm(getLlm());
        modelsCacheByKey.delete('');
        return { ok: true, provider: llmCfg.provider, model: llmCfg.model, endpoint: llmCfg.endpoint ?? null };
      },
      // Advanced settings editor: full `cli` block, shared with the terminal CLI.
      // This intentionally does NOT touch llm/providers/servers so write-only
      // secrets from those sections are not exposed through the JSON textarea.
      'action:set-cli-json': (args) => {
        const raw = typeof args.json === 'string' ? args.json : '{}';
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch (err: any) { throw new Error(`Invalid CLI JSON: ${err?.message ?? err}`); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CLI config must be a JSON object.');
        const fresh = loadConfig();
        const next = parsed as Record<string, unknown>;
        // The renderer's view is scrubbed of secrets, so a whole-block save would
        // wipe the GitHub token. Carry it forward when the incoming JSON omits it.
        const prevTrack = (fresh.cli as { track?: TrackGithubConfig } | undefined)?.track;
        const prevToken = prevTrack?.githubToken;
        const nextTrack = (next.track && typeof next.track === 'object' ? next.track : undefined) as TrackGithubConfig | undefined;
        if (prevToken && (!nextTrack || nextTrack.githubToken === undefined)) {
          next.track = { ...(nextTrack ?? {}), githubToken: prevToken };
        }
        const prevRepoTokens = new Map<string, string>();
        for (const entry of prevTrack?.githubRepos ?? []) {
          if (entry.repo && entry.token) prevRepoTokens.set(entry.repo, entry.token);
        }
        if (prevRepoTokens.size) {
          const targetTrack = ((next.track && typeof next.track === 'object') ? next.track : {}) as TrackGithubConfig;
          if (Array.isArray(targetTrack.githubRepos)) {
            targetTrack.githubRepos = targetTrack.githubRepos.map((entry) => {
              const repo = typeof entry?.repo === 'string' ? entry.repo : '';
              if (!repo || entry.token !== undefined) return entry;
              const token = prevRepoTokens.get(repo);
              return token ? { ...entry, token } : entry;
            });
          } else if (!nextTrack || nextTrack.githubRepos === undefined) {
            targetTrack.githubRepos = prevTrack?.githubRepos;
          }
          next.track = targetTrack;
        }
        // MC-B1 — the trigger signing secrets are scrubbed from the renderer's
        // view too, so carry them forward when the whole-block save omits them
        // (otherwise a raw-editor Save would wipe cli.triggers.*Secret).
        const prevTriggers = (fresh.cli as { triggers?: Record<string, unknown> } | undefined)?.triggers;
        if (prevTriggers && typeof prevTriggers === 'object') {
          const nextTriggers = (next.triggers && typeof next.triggers === 'object' && !Array.isArray(next.triggers))
            ? { ...(next.triggers as Record<string, unknown>) } : undefined;
          const carried = nextTriggers ?? {};
          let touched = false;
          for (const k of ['githubSecret', 'slackSigningSecret', 'gitlabSecret', 'jiraSecret']) {
            if (typeof prevTriggers[k] === 'string' && prevTriggers[k] && carried[k] === undefined) { carried[k] = prevTriggers[k]; touched = true; }
          }
          if (nextTriggers || touched) next.triggers = carried;
        }
        const prevRouter = (fresh.cli as { router?: Record<string, unknown> } | undefined)?.router;
        if (prevRouter && typeof prevRouter === 'object') {
          const nextRouter = (next.router && typeof next.router === 'object' && !Array.isArray(next.router))
            ? { ...(next.router as Record<string, unknown>) } : undefined;
          const carried = nextRouter ?? {};
          if (typeof prevRouter.serveKey === 'string' && prevRouter.serveKey && carried.serveKey === undefined) {
            carried.serveKey = prevRouter.serveKey;
            next.router = carried;
          } else if (nextRouter) {
            next.router = carried;
          }
        }
        fresh.cli = next as typeof fresh.cli;
        saveConfig(fresh);
        _resetCliKnobsCache();
        return { ok: true };
      },
      // Settings → Connectors: persist the Track GitHub config. The token is
      // write-only (set when non-empty, kept otherwise) and never read back.
      'action:set-track-github': (args) => {
        const fresh = loadConfig() as { cli?: { track?: TrackGithubConfig; github?: { caBundle?: string } } };
        const cli = (fresh.cli = fresh.cli ?? {});
        const track = (cli.track = cli.track ?? {});
        if (typeof args.caBundle === 'string' || args.caBundle === null) {
          // CA bundle's home is the global cli.github block (it applies to every
          // GitHub surface); writing here also clears the legacy track-scoped copy.
          const ca = typeof args.caBundle === 'string' ? args.caBundle.trim() : '';
          const github = (cli.github = cli.github ?? {});
          if (ca) github.caBundle = ca;
          else delete github.caBundle;
          delete track.githubCaBundle;
          resetGhEnvCache();
        }
        // Connector Phase 1 — target-scoped save: pick the workspace's sync
        // target and (optionally) attach a pasted token to that connector. The
        // token value stays in cli.track.githubToken (write-only storage, the
        // `config:track` scheme) until Phase 3 moves it into the OS keychain.
        if (typeof args.targetConnectorId === 'string' && typeof args.targetRepo === 'string' && args.targetConnectorId.trim() && args.targetRepo.trim()) {
          const connectorId = args.targetConnectorId.trim();
          const repo = args.targetRepo.trim();
          if (typeof args.token === 'string' && args.token.trim()) {
            track.githubToken = args.token.trim();
            const conn = getConnector(workspaceRoot, connectorId);
            if (conn) {
              updateConnector(workspaceRoot, connectorId, {
                credential: { mode: 'static', ref: 'config:track', label: 'Track token', hasSecret: true },
              });
            }
          }
          setGithubSyncTarget(workspaceRoot, { connectorId, repo });
          syncLegacyTrackGithubFields(track);
          saveConfig(fresh as never);
          _resetCliKnobsCache();
          return { ok: true, ...githubIntegrationSnapshot(workspaceRoot) };
        }
        let repos = normalizeTrackGithubRepos(track);
        if (typeof args.removeRepo === 'string') {
          const removeRepo = args.removeRepo.trim();
          const wasActive = track.activeGithubRepo === removeRepo || track.githubRepo === removeRepo;
          repos = repos.filter((r) => r.repo !== removeRepo);
          if (wasActive) {
            delete track.githubToken;
            track.activeGithubRepo = repos[0]?.repo;
          }
        }
        if (typeof args.repo === 'string') {
          const repo = args.repo.trim();
          if (repo) {
            const idx = repos.findIndex((r) => r.repo === repo);
            const nextEntry = idx >= 0 ? { ...repos[idx] } : { repo };
            if (typeof args.token === 'string' && args.token.trim()) nextEntry.token = args.token.trim();
            if (args.clearToken === true) {
              delete nextEntry.token;
              if (track.githubRepo === repo || track.activeGithubRepo === repo) delete track.githubToken;
            }
            if (idx >= 0) repos[idx] = nextEntry;
            else repos.push(nextEntry);
            if (args.makeActive === true || !track.activeGithubRepo) track.activeGithubRepo = repo;
          }
        } else if (args.clearToken === true) {
          delete track.githubToken;
        }
        track.githubRepos = repos;
        syncLegacyTrackGithubFields(track);
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        return { ok: true, ...githubIntegrationSnapshot(workspaceRoot) };
      },
      // §settings-completeness — set ONE cli.* knob (vs set-cli-json's whole-block
      // replace). `value: null` deletes the key (reverts to the default). Shared
      // with the CLI's config.json.
      // EXTENSIONS — enable/disable an extension (re-load to apply).
      'action:ext-set-enabled': async (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (!name) return { ok: false, error: 'No extension name.' };
        setExtensionEnabled(name, args.enabled === true);
        await loadExtensions(workspaceRoot).catch(() => undefined);
        return { ok: true, name };
      },
      // EXTENSIONS — trust / untrust this workspace, then (re)load so workspace
      // extensions activate or deactivate immediately.
      'action:trust-workspace': async (args) => {
        if (args.trusted === true) trustWorkspace(workspaceRoot);
        else untrustWorkspace(workspaceRoot);
        await loadExtensions(workspaceRoot).catch(() => undefined);
        return { ok: true, trusted: isWorkspaceTrusted(workspaceRoot) };
      },
      'action:set-cli-knob': (args) => {
        const key = typeof args.key === 'string' ? args.key : '';
        if (!key) return { ok: false, error: 'No knob key.' };
        const fresh = loadConfig() as { cli?: Record<string, unknown> };
        const cli = (fresh.cli = fresh.cli ?? {});
        if (args.value === null) delete cli[key]; else cli[key] = args.value;
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        return { ok: true, key };
      },
      'action:set-cli-schema-knob': (args) => {
        const pathArg = typeof args.path === 'string' ? args.path : '';
        const field = findConfigSchemaField(pathArg);
        if (!field) return { ok: false, error: 'Unknown schema field.' };
        const fresh = loadConfig() as { cli?: Record<string, unknown> };
        const cli = (fresh.cli = fresh.cli ?? {});
        setConfigValueAtPath(cli, field.path, args.value);
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        return { ok: true, path: field.path };
      },
      // MC-DESK — sibling-safe nested cli.* writer for the structured Motor
      // Cortex panels (Runtime / Automations / Profiles). Unlike set-cli-knob
      // (which REPLACES a whole top-level key) this sets ONE dotted leaf via
      // setConfigValueAtPath, so writing `triggers.enabled` never erases the
      // sibling `triggers.githubSecret`, and value===null deletes the leaf
      // (revert to default). Not schema-gated — the panels own their paths.
      'action:set-cli-path': (args) => {
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        const segments = path.split('.');
        // Reject empty/edge-dot paths AND prototype-pollution segments — even
        // though this is loopback IPC from our own renderer, a bad path must
        // never reach a native prototype through setConfigValueAtPath.
        if (!path || segments.some((s) => !s || s === '__proto__' || s === 'constructor' || s === 'prototype')) {
          return { ok: false, error: 'Invalid config path.' };
        }
        const fresh = loadConfig() as { cli?: Record<string, unknown> };
        const cli = (fresh.cli = fresh.cli ?? {});
        setConfigValueAtPath(cli, path, args.value === undefined ? null : args.value);
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        return { ok: true, path };
      },
      // MC-DESK Batch 2 — live runtime/automation actions for the monitor cards.
      'action:runtime-remove-record': (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { ok: false, error: 'No runtime id.' };
        try { removeRuntimeRecord(workspaceRoot, id); return { ok: true, id }; }
        catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'remove failed' }; }
      },
      'action:runtime-resume-archive': (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { ok: false, error: 'No archive id.' };
        try {
          const r = resumeFromArchive(id);
          return { ok: true, id, worktreeRoot: r.worktreeRoot, patchApplied: r.patchApplied, filesRestored: r.filesRestored, patchError: r.patchError ?? null };
        } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'resume failed' }; }
      },
      'action:runtime-prune-archives': (args) => {
        const keepN = typeof args.keepN === 'number' && Number.isFinite(args.keepN) ? args.keepN : undefined;
        try { const removed = pruneArchives(keepN === undefined ? {} : { keepN }); return { ok: true, removed }; }
        catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'prune failed' }; }
      },
      'action:automation-rule-enabled': (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        const enabled = args.enabled === true;
        if (!id) return { ok: false, error: 'No rule id.' };
        const ok = setAutomationRuleEnabled(workspaceRoot, id, enabled);
        return { ok, id, enabled };
      },
      // MC-DESK — in-host trigger-ingress lifecycle (Settings → Automations).
      // Same default-deny gates as `serve --triggers`; the handle lives in
      // triggerServe.ts so a second start is a no-op and stop closes it.
      'action:triggers-serve-start': () => startTriggerServe(workspaceRoot),
      'action:triggers-serve-stop': () => stopTriggerServe(),
      'action:router-serve-start': () => startRouterServe(),
      'action:router-serve-stop': () => stopRouterServe(),
      'action:set-github-oauth-client-id': (args) => {
        const fresh = loadConfig() as { cli?: { github?: { oauthClientId?: string; caBundle?: string } } };
        const cli = (fresh.cli = fresh.cli ?? {});
        const github = (cli.github = cli.github ?? {});
        const clientId = typeof args.clientId === 'string' ? args.clientId.trim() : '';
        if (clientId) github.oauthClientId = clientId;
        else delete github.oauthClientId;
        if (!github.oauthClientId && !github.caBundle) delete cli.github;
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        return { ok: true };
      },
      // §multi-provider — add/update a NAMED OpenAI-compatible provider. A blank
      // apiKey on an UPDATE keeps the existing key (so the renderer never has to
      // echo it back). Returns the masked provider list.
      'action:set-provider': (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) return { ok: false, error: 'Provider name must be letters, digits, . _ - only.' };
        const fresh = loadConfig();
        const existing = fresh.providers?.[name];
        const providerId = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : (existing?.provider ?? 'openai');
        // §multi-select-models — the renderer sends the checked allowlist. Three
        // cases on EDIT: omitted (undefined) keeps the existing allowlist; an
        // explicit array (incl. []) replaces it; [] clears it. normalizeProviderModels
        // then enforces the invariant "default model ∈ models" (self-healing to
        // models[0]) so the single default and the allowlist can never disagree.
        const rawModels = Array.isArray(args.models)
          ? (args.models as unknown[]).filter((m): m is string => typeof m === 'string')
          : undefined;
        const allowlist = rawModels !== undefined ? rawModels : existing?.models;
        const cachedModels = Array.isArray(args.cachedModels)
          ? [...new Set((args.cachedModels as unknown[]).filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean))]
          : existing?.cachedModels;
        const rawModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : (existing?.model ?? '');
        const { model, models } = normalizeProviderModels(rawModel, allowlist);
        // Optional Azure-style api-version: explicit string sets/keeps it, '' clears,
        // omitted (undefined) preserves the existing value.
        const apiVersion = typeof args.apiVersion === 'string' ? args.apiVersion.trim() : existing?.apiVersion;
        const llmCfg: LLMConfig = {
          provider: providerId,
          apiKey: typeof args.apiKey === 'string' && args.apiKey.trim() ? args.apiKey.trim() : (existing?.apiKey ?? ''),
          model,
          endpoint: typeof args.endpoint === 'string' ? (args.endpoint.trim() || PROVIDER_CATALOG.find((p) => p.id === providerId)?.endpoint || undefined) : (existing?.endpoint ?? PROVIDER_CATALOG.find((p) => p.id === providerId)?.endpoint),
          ...(models ? { models } : {}),
          ...(cachedModels && cachedModels.length ? { cachedModels, cachedAt: new Date().toISOString() } : {}),
          ...(apiVersion ? { apiVersion } : {}),
          ...(args.free === true ? { free: true } : existing?.free === true && args.free !== false ? { free: true } : {}),
          ...(args.passthroughUnknown === true ? { passthroughUnknown: true } : existing?.passthroughUnknown === true && args.passthroughUnknown !== false ? { passthroughUnknown: true } : {}),
        };
        if (!llmCfg.model) return { ok: false, error: 'A model is required.' };
        saveConfig(setProvider(fresh, name, llmCfg));
        return { ok: true, name };
      },
      'action:remove-provider': (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) return { ok: false, error: 'No provider name.' };
        saveConfig(removeProvider(loadConfig(), name));
        return { ok: true, name };
      },
      // §provider-unify — promote a configured provider to be the DEFAULT (the
      // main model picks straight from it): copy its endpoint + KEY (resolved
      // host-side, never echoed to the renderer) + model into `config.llm`.
      'action:set-default-provider': (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        let fresh = loadConfig();
        const p = fresh.providers?.[name];
        if (!p) return { ok: false, error: `Unknown provider "${name}".` };
        fresh.llm = { provider: p.provider, apiKey: p.apiKey, model: p.model, endpoint: p.endpoint };
        const fallback = fresh.agentModels?.default;
        const fallbackDuplicatesMain =
          !!fallback &&
          (
            (fallback.provider === name && (!fallback.model || fallback.model === p.model)) ||
            (!fallback.provider && (!fallback.model || fallback.model === p.model))
          );
        if (fallbackDuplicatesMain) fresh = setAgentModel(fresh, 'default', {});
        saveConfig(fresh);
        setLlm(fresh.llm ?? getLlm());
        syncActiveSessionLlm(getLlm());
        modelsCacheByKey.delete('');
        return { ok: true, provider: p.provider, model: p.model, endpoint: p.endpoint ?? null };
      },
      // §multi-provider — route a sub-agent ROLE to a provider/model. Blank
      // provider+model CLEARS the role (inherits the main model).
      'action:set-agent-model': (args) => {
        const role = typeof args.role === 'string' ? args.role.trim() : '';
        if (!role) return { ok: false, error: 'No role.' };
        const provider = typeof args.provider === 'string' ? args.provider.trim() : '';
        const model = typeof args.model === 'string' ? args.model.trim() : '';
        const fresh = loadConfig();
        const defaultProviderName = matchingDefaultProvider(fresh.providers, fresh.llm).name ?? undefined;
        const providerCfg = provider ? fresh.providers?.[provider] : undefined;
        const duplicatesMain =
          (!provider && (!model || model === fresh.llm?.model)) ||
          (!!provider && provider === defaultProviderName && (!model || model === fresh.llm?.model || model === providerCfg?.model));
        saveConfig(setAgentModel(fresh, role, duplicatesMain ? {} : { provider, model }));
        return { ok: true, role, cleared: duplicatesMain };
      },
      // DESK-5c/5l — live model list from the configured endpoint (cached 60s).
      // Empty results are NOT cached: a transient endpoint hiccup used to pin
      // an empty list for a minute, leaving the picker with nothing to switch
      // to. Failures fall back to the last good list when there is one.
      // Every OpenAI-compatible endpoint exposes GET /models — so the model
      // pickers are ALWAYS endpoint-driven, never a hand-written list. With no
      // arg this lists the active llm's models; `{ provider }` lists a named
      // provider's (the key is resolved HERE so it never leaves the host).
      // Tool enable/disable catalog — the built-in agent tools (with their
      // protected flag) + the connected MCP tools, so Settings can render a toggle
      // per tool. The current on/off state is read from cli.toolOverrides in the
      // config snapshot; this just enumerates what exists.
      'tool-catalog': async () => {
        const builtin = localToolSpecsFromExecutors().map((t) => ({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          protected: isProtectedCoreTool(t.name),
        }));
        let mcp: Array<{ server: string; name: string }> = [];
        try {
          const res = (await mcpClient.listTools()) as { tools?: Array<{ name?: string }> };
          mcp = (res.tools ?? [])
            .map((t) => String(t?.name ?? ''))
            .filter(Boolean)
            .map((full) => {
              const m = full.match(/^mcp_([^_]+)_/);
              return { server: m ? m[1] : 'mcp', name: full };
            });
        } catch {
          mcp = [];
        }
        return { builtin, mcp };
      },
      'list-models': async (a) => {
        const fresh = loadConfig();
        setLlm(fresh.llm ?? getLlm());
        const provName = typeof a?.provider === 'string' && a.provider ? a.provider : undefined;
        const prov = provName ? (fresh.providers ?? {})[provName] : undefined;
        // A named provider that isn't configured yet → nothing to list.
        if (provName && !prov) return { models: [], current: '', provider: provName };
        const activeLlm = prov ? undefined : syncActiveSessionLlm(getLlm());
        const l = prov ?? activeLlm ?? getLlm();
        const cacheKey = provName ?? '';
        const now = Date.now();
        const cached = modelsCacheByKey.get(cacheKey);
        const current = prov ? (prov.model ?? '') : (getActiveAgent().getModel?.() ?? l.model);
        if (cached && now - cached.at < 60_000) return { models: cached.models, current, provider: provName };
        // Public/anonymous tier (opencode "public") — list free models with no key.
        const fallbackKey = PROVIDER_CATALOG.find((p) => p.id === (l.provider ?? '').toLowerCase())?.defaultApiKey ?? '';
        const { models } = await fetchEndpointModels(l.endpoint, (l.apiKey && l.apiKey.trim()) ? l.apiKey : fallbackKey, l.apiVersion);
        if (models.length) modelsCacheByKey.set(cacheKey, { models, at: now });
        return { models: models.length ? models : (cached?.models ?? []), current, provider: provName };
      },
      // §multi-select-models — probe a provider's GET /models with the DRAFT key
      // the user just typed in the setup dialog (NOT a saved provider's stored
      // key), so the dialog can show how many models that key unlocks BEFORE the
      // provider is saved. Endpoint resolves explicit → catalog(provider id) →
      // active llm. Deliberately does NOT read or write `modelsCacheByKey` (that
      // 60s cache is for saved providers / the active llm — a draft-key probe must
      // never poison it) and never persists config. Reuses the same
      // fetchEndpointModels contract (5s timeout, Bearer, `local` for blank keys).
      'list-models-probe': async (a) => {
        const endpoint = typeof a?.endpoint === 'string' ? a.endpoint.trim() : '';
        const apiKey = typeof a?.apiKey === 'string' ? a.apiKey : '';
        const apiVersion = typeof a?.apiVersion === 'string' ? a.apiVersion : '';
        const provId = typeof a?.provider === 'string' ? a.provider : '';
        const ep = endpoint || PROVIDER_CATALOG.find((p) => p.id === provId)?.endpoint || loadConfig().llm?.endpoint || '';
        const { models, status, error } = await fetchEndpointModels(ep || undefined, apiKey, apiVersion);
        // Surface WHY a probe came back empty so the dialog can validate the key:
        // a 4xx (esp. 401/403) means the key/endpoint was rejected; 'unreachable'
        // means the request never landed. A 200 with no models needs no reason.
        const reason = error ? 'unreachable' : (typeof status === 'number' && status >= 400 ? `http-${status}` : undefined);
        return { models, count: models.length, provider: provId || null, probe: true, ...(reason ? { error: reason } : {}) };
      },
      // DESK-5c — real terminal sessions (offset-poll streaming).
      'term-open': () => {
        const id = `t${nextTermSeq()}`;
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
        const args = isWin ? ['-NoLogo'] : ['-i'];
        const proc = spawn(shell, args, {
          cwd: workspaceRoot,
          env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
        });
        const sess: TermSession = { proc, buf: '', alive: true };
        const append = (d: Buffer | string) => {
          sess.buf += typeof d === 'string' ? d : d.toString('utf-8');
          if (sess.buf.length > TERM_BUF_CAP) sess.buf = sess.buf.slice(-TERM_BUF_CAP);
        };
        // CRITICAL — a spawn failure (shell missing, EACCES) is emitted as an
        // ASYNC 'error' event AFTER this handler returns. With no listener Node
        // treats it as an unhandled error and crashes the whole host process,
        // which takes down `npm start`. Catch it: mark the session dead and put
        // the reason in the buffer so the panel shows an error, not a blank hang.
        proc.on('error', (err) => {
          sess.alive = false;
          append(`\r\n[terminal failed to start ${shell}: ${err instanceof Error ? err.message : String(err)}]\r\n`);
        });
        proc.stdout.on('data', append);
        proc.stderr.on('data', append);
        // A bare stream 'error' (e.g. EPIPE when the shell dies mid-write) also
        // throws if unlistened — swallow it; `exit`/`error` above own recovery.
        proc.stdin.on('error', () => { sess.alive = false; });
        proc.stdout.on('error', () => { /* stream closed; exit handler cleans up */ });
        proc.stderr.on('error', () => { /* stream closed; exit handler cleans up */ });
        proc.on('exit', (code) => { sess.alive = false; append(`\r\n[shell exited ${code ?? '?'}]\r\n`); });
        terms.set(id, sess);
        return { id, shell };
      },
      'term-write': (args) => {
        const sess = terms.get(String(args.id));
        if (!sess?.alive) return { ok: false };
        // Guard stdin.write — writing to a shell that just died raises EPIPE,
        // which (unguarded) would crash the host the same way the spawn error did.
        try { sess.proc.stdin.write(String(args.data ?? '')); } catch { sess.alive = false; return { ok: false }; }
        return { ok: true };
      },
      'term-read': (args) => {
        const sess = terms.get(String(args.id));
        if (!sess) return { chunk: '', next: 0, alive: false };
        const from = Math.max(0, Math.min(Number(args.from) || 0, sess.buf.length));
        return { chunk: sess.buf.slice(from), next: sess.buf.length, alive: sess.alive };
      },
      'term-kill': (args) => {
        const sess = terms.get(String(args.id));
        if (sess) { try { sess.proc.kill(); } catch { /* already gone */ } terms.delete(String(args.id)); }
        return { ok: true };
      },
      // WS2 2.4 / WS6 6.3 — stop a background shell (e.g. a dev server an agent
      // started) from the Background-tasks panel. Kills the whole process group.
      'action:kill-bgshell': (args) => ({ ok: killBackgroundShell(String(args.id ?? '')) }),
      // Actions — host-side mutations the Settings dialog / palette trigger.
      // They ride the query channel (free-form names, result routing by id).
      'action:clear': () => { getActiveAgent().clearHistory(); return { ok: true }; },
      // WS8 — rewind the conversation to the message at (epoch) `ts`. Blocked when
      // code was generated after that point (rewindTranscript → canRewindTo); the
      // renderer surfaces the reason as an in-app warning. On success the
      // transcript is truncated and the agent's history reloaded from that point.
      'action:rewind-to': (args) => {
        const ts = typeof args.ts === 'number' ? args.ts : NaN;
        if (!Number.isFinite(ts)) return { ok: false, reason: 'Invalid rewind point.' };
        const entries = loadTranscript(workspaceRoot, getActiveAgent().sessionKey);
        let index = -1;
        for (let i = 0; i < entries.length; i++) {
          const et = Date.parse(entries[i].timestamp);
          if (Number.isFinite(et) && et <= ts) index = i;
        }
        if (index < 0) return { ok: false, reason: 'Could not find that point in the transcript.' };
        const r = rewindTranscript(workspaceRoot, getActiveAgent().sessionKey, index);
        if (!r.ok) return { ok: false, reason: r.reason };
        getActiveAgent().loadHistory(r.kept);
        return { ok: true, kept: r.kept.length };
      },
      'action:compact': async () => getActiveAgent().compactHistory(),
      'action:set-pref': (args) => {
        const key = typeof args.key === 'string' ? args.key : '';
        const SETTABLE = new Set(['delegationPolicy', 'autoChain', 'personality', 'tier', 'theme', 'quiet', 'memoriesEnabled', 'personaAnchorEnabled', 'experimental', 'rawScrollback', 'editorMode']);
        if (!SETTABLE.has(key)) throw new Error(`Preference "${key}" is not settable from the desktop.`);
        return writePreferences(workspaceRoot, { [key]: args.value } as never);
      },
      'action:set-session-mode': (args) => {
        const parsed = desktopSessionModePatchFromArgs(args);
        if (parsed.error) throw new Error(parsed.error);
        const sessionMode = setSessionMode(workspaceRoot, getActiveAgent().sessionKey, parsed.patch);
        const activeMode = resolveActiveMode(workspaceRoot, getActiveAgent().sessionKey);
        return { ok: true, sessionKey: getActiveAgent().sessionKey, sessionMode, activeMode };
      },
      'action:set-hook': (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        return { ok: setHookEnabled(workspaceRoot, id, args.enabled === true) };
      },
      'action:set-access': (args) => {
        const mode = args.mode;
        if (mode !== 'read' && mode !== 'write' && mode !== 'shell') throw new Error(`Unknown access mode "${String(mode)}".`);
        getActiveAgent().setAccessMode(mode);
        return { ok: true, mode };
      },
      'action:reconnect-mcp': async (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        await mcpClient.reconnectOne(id);
        return { ok: true };
      },
      // WS9 — choose which BrainRouter brain is ACTIVE (only one at a time; the
      // user can keep several configured). selectMcpServerIds already enforces
      // single-active at connect time; this persists the choice + reconnects.
      'action:set-active-server': async (args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id) return { ok: false, error: 'No server id.' };
        const fresh = loadConfig();
        (fresh as { activeServer?: string }).activeServer = id;
        saveConfig(fresh);
        try { await mcpClient.reconnectOne(id); } catch { /* offline brains surface in status */ }
        return { ok: true, activeServer: id };
      },
      // T6 — add an MCP server: write the profile to config.json (shared with the
      // CLI) and connect it now. type 'stdio' needs a command; 'http' needs a url.
      'action:add-mcp': async (args) => {
        const id = String(args.id ?? '').trim();
        const type = args.type === 'http' ? 'http' : 'stdio';
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, error: 'Server id must be letters, digits, dash, underscore or dot.' };
        // Optional auth/headers/env (a "KEY=value\nKEY2=value2" string → record).
        const kvPairs = (raw: unknown): Record<string, string> => {
          const out: Record<string, string> = {};
          if (raw && typeof raw === 'object') return raw as Record<string, string>;
          if (typeof raw === 'string') for (const line of raw.split('\n')) {
            const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          }
          return out;
        };
        const apiKey = String(args.apiKey ?? '').trim();
        const headers = kvPairs(args.headers); const env = kvPairs(args.env);
        const cfg = type === 'http'
          ? { type: 'http' as const, url: String(args.url ?? '').trim(),
              ...(apiKey ? { apiKey } : {}), ...(Object.keys(headers).length ? { headers } : {}) }
          : { type: 'stdio' as const, command: String(args.command ?? '').trim(), args: typeof args.args === 'string' ? args.args.trim().split(/\s+/).filter(Boolean) : [],
              ...(Object.keys(env).length ? { env } : {}) };
        const required = cfg.type === 'http' ? cfg.url : cfg.command;
        if (!required) return { ok: false, error: `A ${type} server needs a ${type === 'http' ? 'url' : 'command'}.` };
        const fresh = loadConfig() as { servers?: Record<string, unknown> };
        fresh.servers = fresh.servers ?? {};
        if (fresh.servers[id]) return { ok: false, error: `A server named "${id}" already exists.` };
        fresh.servers[id] = cfg;
        saveConfig(fresh as never);
        try { await mcpClient.connectOne(id, cfg as never, loadConfig().llm ?? getLlm(), 5_000); } catch { /* offline — config saved, connect on next boot */ }
        return { ok: true, id };
      },
      'action:remove-mcp': async (args) => {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, error: 'No server id.' };
        try { await mcpClient.disconnectOne(id); } catch { /* already gone */ }
        const fresh = loadConfig() as { servers?: Record<string, unknown> };
        if (fresh.servers && fresh.servers[id]) { delete fresh.servers[id]; saveConfig(fresh as never); }
        return { ok: true, id };
      },
      // ADR-016 C0 — sign in to a BrainRouter backend and point the active brain
      // at it over HTTP with the returned per-user apiKey, so memory becomes
      // backend-backed (the same MCP plane the CLI/dashboard use). The apiKey lives
      // in the brain server profile like any other MCP key; the previous (embedded)
      // profile is stashed under cli.account so sign-out restores it non-destructively.
      'action:auth-signin': async (args) => {
        const email = String(args.email ?? '').trim();
        const password = String(args.password ?? '');
        const baseUrl = (String(args.url ?? '').trim() || 'http://localhost:3747').replace(/\/+$/, '');
        if (!email || !password) return { ok: false, error: 'Email and password are required.' };
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/api/auth/signin`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
        } catch { return { ok: false, error: `Cannot reach BrainRouter at ${baseUrl}.` }; }
        if (!res.ok) {
          let msg = `Sign-in failed (HTTP ${res.status})`;
          try { const j = await res.json() as { error?: string }; if (j?.error) msg = j.error; } catch { /* keep default */ }
          return { ok: false, error: msg };
        }
        const data = await res.json() as { apiKey?: string; userId?: string; displayName?: string; email?: string };
        const apiKey = String(data.apiKey ?? '').trim();
        if (!apiKey) return { ok: false, error: 'Sign-in succeeded but returned no API key.' };
        const isBrain = (id: string, s: { identity?: string } | undefined) => s?.identity === 'brainrouter' || /^brainrouter/i.test(id);
        const fresh = loadConfig() as { servers?: Record<string, unknown>; cli?: Record<string, unknown> };
        fresh.servers = fresh.servers ?? {};
        const brainId = Object.keys(fresh.servers).find((id) => isBrain(id, fresh.servers![id] as { identity?: string })) ?? 'brainrouter';
        const prevBrain = fresh.servers[brainId] ?? null;
        const mcpUrl = `${baseUrl}/mcp`;
        const account = { url: baseUrl, mcpUrl, userId: data.userId ?? '', displayName: data.displayName ?? email, email: data.email ?? email };
        fresh.servers[brainId] = { type: 'http', url: mcpUrl, apiKey, identity: 'brainrouter' };
        fresh.cli = fresh.cli ?? {};
        fresh.cli.brainUrl = mcpUrl;
        fresh.cli.account = { ...account, prevBrain };
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        try { await mcpClient.disconnectOne(brainId); } catch { /* not connected */ }
        try { await mcpClient.connectOne(brainId, fresh.servers[brainId] as never, loadConfig().llm ?? getLlm(), 5_000); }
        catch { return { ok: false, error: `Signed in, but couldn't reach the brain at ${mcpUrl}. Is the backend running?` }; }
        return { ok: true, account };
      },
      'action:auth-signout': async () => {
        const isBrain = (id: string, s: { identity?: string } | undefined) => s?.identity === 'brainrouter' || /^brainrouter/i.test(id);
        const fresh = loadConfig() as { servers?: Record<string, unknown>; cli?: { account?: { prevBrain?: unknown } } & Record<string, unknown> };
        const prevBrain = fresh.cli?.account?.prevBrain ?? null;
        const brainId = fresh.servers ? Object.keys(fresh.servers).find((id) => isBrain(id, fresh.servers![id] as { identity?: string })) : undefined;
        if (brainId && fresh.servers) {
          if (prevBrain) fresh.servers[brainId] = prevBrain;
          else delete fresh.servers[brainId];
        }
        if (fresh.cli) { delete fresh.cli.brainUrl; delete fresh.cli.account; }
        saveConfig(fresh as never);
        _resetCliKnobsCache();
        try { if (brainId) await mcpClient.disconnectOne(brainId); } catch { /* already gone */ }
        try { if (brainId && fresh.servers?.[brainId]) await mcpClient.connectOne(brainId, fresh.servers[brainId] as never, loadConfig().llm ?? getLlm(), 5_000); }
        catch { /* embedded brain reconnects on next boot */ }
        return { ok: true };
      },
      'auth-status': () => {
        const account = (loadConfig() as { cli?: { account?: { url?: string; userId?: string; displayName?: string; email?: string } } }).cli?.account;
        return account
          ? { signedIn: true, account: { url: account.url ?? '', userId: account.userId ?? '', displayName: account.displayName ?? '', email: account.email ?? '' } }
          : { signedIn: false, account: null };
      },
      // DESK-6m — per-chat context-menu actions (Pin / Mark completed / Rename /
      // Move to group / Archive / Delete / Fork / Open). All write the shared
      // CLI stores, so the terminal sees the same titles/pins/groups.
      'action:session-meta': (args) => {
        // WS-UX — optional `root` lets the sidebar edit a session in a NON-active
        // workspace (parked project) without switching to it. Defaults to active.
        const root = typeof args.root === 'string' && args.root ? args.root : workspaceRoot;
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        if (!sessionKey) throw new Error('session-meta: missing sessionKey');
        const patch = (args.patch ?? {}) as Partial<SessionMeta>;
        const meta = setSessionMeta(root, sessionKey, patch);
        return { ok: true, sessionKey, meta, groups: listSessionGroups(root) };
      },
      'action:session-delete': (args) => {
        const root = typeof args.root === 'string' && args.root ? args.root : workspaceRoot;
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        if (!sessionKey) throw new Error('session-delete: missing sessionKey');
        const removed = deleteSession(root, sessionKey);
        removeSessionMeta(root, sessionKey);
        return { ok: removed, sessionKey };
      },
      'action:session-fork': (args) => {
        const root = typeof args.root === 'string' && args.root ? args.root : workspaceRoot;
        const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
        if (!sessionKey) throw new Error('session-fork: missing sessionKey');
        // DESK-6v — upToTs (epoch ms) branches from a specific message; absent = whole-conversation fork.
        const upToTs = typeof args.upToTs === 'number' ? args.upToTs : undefined;
        const newKey = forkSession(root, sessionKey, upToTs);
        if (newKey) {
          // Record the lineage + carry the title forward with a "(fork)" suffix so
          // it's recognizable. forkedFrom drives the sidebar fork icon and the
          // "Forked from conversation" back-link in the renderer.
          const src = getSessionMeta(root, sessionKey);
          setSessionMeta(root, newKey, { forkedFrom: sessionKey, ...(src.title ? { title: `${src.title} (fork)` } : {}) });
        }
        return { ok: !!newKey, newKey };
      },
      'action:session-groups': () => ({ groups: listSessionGroups(workspaceRoot) }),
      // DESK-6m — "Open PR" / "Open in {editor,finder,terminal}" for the workspace.
      'action:open-external': (args) => {
        const what = typeof args.what === 'string' ? args.what : '';
        const root = workspaceRoot;
        const sh = (cmd: string) => new Promise<void>((resolve) => exec(cmd, { cwd: root, timeout: 8_000 }, () => resolve()));
        const isWin = process.platform === 'win32', isMac = process.platform === 'darwin';
        // HOTFIX — cmd.exe does NOT strip single quotes, so an arg must be double-
        // quoted on Windows or the opener silently fails (PR/CI links never opened).
        const q = (s: string) => shellQuoteArg(s, isWin);
        // T6 — open an explicit URL (CI/check/run links). https-only so a malicious
        // gh payload can't smuggle a file:// or shell-ish scheme; shell-quoted.
        const url = typeof args.url === 'string' ? args.url : '';
        if (url) {
          if (!/^https:\/\/[^\s'"]+$/.test(url)) return { ok: false, error: 'only https URLs are allowed' };
          void sh(isMac ? `open ${q(url)}` : isWin ? `start "" ${q(url)}` : `xdg-open ${q(url)}`);
          return { ok: true, url };
        }
        if (what === 'pr') { void sh('gh pr view --web'); return { ok: true, what }; }
        if (what === 'editor') { void sh(`code ${q(root)} || cursor ${q(root)} || ${isMac ? `open ${q(root)}` : isWin ? `start "" ${q(root)}` : `xdg-open ${q(root)}`}`); return { ok: true, what }; }
        if (what === 'finder') { void sh(isMac ? `open ${q(root)}` : isWin ? `explorer ${q(root)}` : `xdg-open ${q(root)}`); return { ok: true, what }; }
        if (what === 'terminal') { void sh(isMac ? `open -a Terminal ${q(root)}` : isWin ? `start cmd /K cd /d ${q(root)}` : `x-terminal-emulator --working-directory=${q(root)} || gnome-terminal --working-directory=${q(root)}`); return { ok: true, what }; }
        return { ok: false, what };
      },
  };
}
