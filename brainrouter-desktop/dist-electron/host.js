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
import { createBrokerPort, createHostCore } from './hostCore.js';
import { mergeGithubCliEnv, normalizeGithubCliError } from './ghCli.js';
import { shellQuoteArg } from './shellQuote.js';
import { exec, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { Agent } from '@kinqs/brainrouter-core/dist/agent/agent.js';
import { loadConfig, saveConfig, getCliKnobs, _resetCliKnobsCache } from '@kinqs/brainrouter-core/dist/config/config.js';
// 0.4.15 — named providers + per-sub-agent model routing (pure transforms).
import { setProvider, removeProvider, setAgentModel, normalizeProviderModels } from '@kinqs/brainrouter-core/dist/provider/agentModels.js';
import { McpClientPool } from '@kinqs/brainrouter-core/dist/mcp/mcpPool.js';
import { listTranscripts, loadTranscript, readTranscriptTail, transcriptExists, transcriptSizeBytes, deleteSession, forkSession, appendTranscriptEntry, rewindTranscript } from '@kinqs/brainrouter-core/dist/session/sessionStore.js';
import { readUsageHistory, totalUsage } from '@kinqs/brainrouter-core/dist/usage/usageHistoryStore.js';
import { classifyForVerification } from '@kinqs/brainrouter-core/dist/agent/verificationGate.js';
import { resolveWorkspaceGit } from '@kinqs/brainrouter-core/dist/git/workspaceGit.js';
import { readWorkspaceEntry, isWorkspaceDirectory, listWorkspaceFiles, statWorkspaceEntry, writeWorkspaceEntry } from './fsRead.js';
import { saveWorkflowGraph, loadWorkflowGraph, listWorkflowGraphs, deleteWorkflowGraph } from '@kinqs/brainrouter-core/dist/workflow/graphStore.js';
import { writeThreadKey, buildGroundingBlock, pickLocalGrounding } from '@kinqs/brainrouter-core/dist/write/grounding.js';
import { WorkspaceFileListCache } from './workspaceFileListCache.js';
import { startWorkspaceWatcher } from './fileWatch.js';
import { readSessionMetaAll, getSessionMeta, setSessionMeta, removeSessionMeta, listSessionGroups } from '@kinqs/brainrouter-core/dist/session/sessionMetaStore.js';
import { getSessionRuntime, setSessionRuntime, resolveSessionLlmConfig } from '@kinqs/brainrouter-core/dist/session/sessionRuntimeStore.js';
import { getSessionMode, setSessionMode, resolveActiveMode } from '@kinqs/brainrouter-core/dist/session/sessionModeStore.js';
import { loadSchedules, addSchedule, removeSchedule, setScheduleEnabled } from '@kinqs/brainrouter-core/dist/schedule/scheduleStore.js';
import { parseCron, nextCronFire } from '@kinqs/brainrouter-core/dist/schedule/cronParser.js';
import { applyRuleEdit } from '@kinqs/brainrouter-core/dist/config/permissionRules.js';
import { parseReviewFindings, REVIEW_OUTPUT_CONTRACT, stripReasoning } from '@kinqs/brainrouter-core/dist/review/reviewFindings.js';
import { hashDiff, reviewGate, staleIfDiffChanged, isFindingStatus } from '@kinqs/brainrouter-core/dist/review/reviewModel.js';
import { getLatestReview, saveReview, updateReviewFinding } from '@kinqs/brainrouter-core/dist/review/reviewStore.js';
import { getStateDir } from '@kinqs/brainrouter-core/dist/storage/store.js';
import { buildRecap } from '@kinqs/brainrouter-core/dist/session/sessionRecap.js';
import { collectRunningTasks } from '@kinqs/brainrouter-core/dist/background/backgroundTasks.js';
import { killBackgroundShell } from '@kinqs/brainrouter-core/dist/exec/backgroundShell.js';
import { contextWindowForBudget } from '@kinqs/brainrouter-core/dist/context/contextWindow.js';
// DESK-4c — the command/settings surfaces reuse the CLI's own modules so the
// desktop never drifts from the terminal: same catalog, same preferences
// file, same hooks store, same transcript tooling.
import { SLASH_COMMANDS, HELP_CATEGORIES } from '@kinqs/brainrouter-core/dist/command/catalog.js';
import { validateCatalogParity } from '@kinqs/brainrouter-core/dist/command/parity.js';
import { readPreferences, writePreferences } from '@kinqs/brainrouter-core/dist/session/preferencesStore.js';
import { readHooks, setHookEnabled } from '@kinqs/brainrouter-core/dist/hooks/hooksStore.js';
import { searchTranscript } from '@kinqs/brainrouter-core/dist/session/transcriptSearch.js';
import { exportTranscriptMarkdown, exportTranscriptJson, exportFileName } from '@kinqs/brainrouter-core/dist/session/transcriptExport.js';
import { listChapters } from '@kinqs/brainrouter-core/dist/session/chapterMarks.js';
import { buildUsageBreakdown } from '@kinqs/brainrouter-core/dist/util/usageBreakdown.js';
// DESK-5 — the command bridge dispatches REPL-only commands against the SAME
// stores the terminal CLI uses. No parallel state: /goal here is /goal there.
import { readGoal, setGoal, clearGoal, pauseGoal, resumeGoal, editGoal, decideGoalContinuation, buildGoalContinuationPrompt, goalCorrectiveNotice, tickGoalIteration, usageLimitGoal, formatBudget } from '@kinqs/brainrouter-core/dist/goal/goalStore.js';
// §goal-autonomy — the kickoff prompt builder (shared with the CLI's /goal).
import { buildGoalKickoffPrompt } from '@kinqs/brainrouter-core/dist/goal/goalKickoff.js';
import { PROVIDER_CATALOG } from '@kinqs/brainrouter-core/dist/provider/catalog.js';
import { LOCAL_PLACEHOLDER_KEY, withApiVersion } from '@kinqs/brainrouter-core/dist/provider/providers/index.js';
import { inferModelReasoningCapabilities, registerModelReasoningCapabilities } from '@kinqs/brainrouter-core/dist/provider/models/reasoning.js';
import { refreshLmStudioCache } from '@kinqs/brainrouter-core/dist/provider/providers/lmstudio.js';
import { loadExtensions } from '@kinqs/brainrouter-core/dist/extension/loader.js';
import { listExtensions } from '@kinqs/brainrouter-core/dist/extension/manifest.js';
import { isExtensionEnabled, setExtensionEnabled } from '@kinqs/brainrouter-core/dist/extension/extensionStore.js';
import { extensionContributionSummary } from '@kinqs/brainrouter-core/dist/extension/registry.js';
import { isWorkspaceTrusted, trustWorkspace, untrustWorkspace } from '@kinqs/brainrouter-core/dist/workspace/workspaceTrust.js';
import { readPlan, formatPlan, seedPlanFromRequirement, updatePlan } from '@kinqs/brainrouter-core/dist/task/taskStore.js';
// DURABLE BACKGROUND TASKS (0.4.15 workflow gaps) — plan-revision + review work
// runs as visible, file-backed tasks (shared with the CLI store) so progress +
// transcript survive workspace/session switches and host reload.
import { createBackgroundTask, updateBackgroundTask, appendTaskProgress, listBackgroundTasks, getBackgroundTask, linkBackgroundTaskMemory, currentPhase, reconcileBackgroundTasks, } from '@kinqs/brainrouter-core/dist/background/backgroundTaskStore.js';
import { collectDurableRunningTasks } from '@kinqs/brainrouter-core/dist/background/backgroundTasks.js';
import { pidAlive } from '@kinqs/brainrouter-core/dist/background/backgroundReconcile.js';
// ATTACHMENTS (0.4.15 workflow gaps) — ingest files (drag/drop + picker) into
// durable attachment records, shared with the CLI `/attach` store.
import { ingestAttachment, attachmentContextMarkdown } from '@kinqs/brainrouter-core/dist/attachment/ingest.js';
import { listAttachments, getAttachment, linkAttachmentMemory } from '@kinqs/brainrouter-core/dist/attachment/attachmentStore.js';
// TELEMETRY (0.4.15 workflow gaps) — local-first task/review/upload lifecycle.
import { recordTelemetry } from '@kinqs/brainrouter-core/dist/telemetry/telemetry.js';
import { TELEMETRY_EVENTS } from '@kinqs/brainrouter-core/dist/telemetry/contracts.js';
// §7 PLAN REVIEW — durable plan approval + version history (per-session decision
// log that snapshots the plan). Shared with the CLI's /plan approve·request-changes·
// history; the desktop panel reads/records through these thin wrappers — no
// parallel store. A best-effort memory note is captured + linked, mirroring the CLI.
import { readPlanHistory, recordPlanDecision, linkPlanDecision } from '@kinqs/brainrouter-core/dist/task/planHistoryStore.js';
import { emitAgentEvent, emitArtifactCapture, emitAnnotationCapture } from '@kinqs/brainrouter-core/dist/memory/memoryEvents.js';
// REQUIREMENT-RECORDS — Requirement Records store (shared with the CLI).
import { listRequirements, getRequirement, createRequirement, updateRequirement, linkRequirement, deleteRequirement } from '@kinqs/brainrouter-core/dist/requirement/requirementStore.js';
import { buildBaseGraph, saveAtlasGraph, readAtlasGraph, atlasGraphStats, atlasWorkspaceTag, enrichAtlasGraph, extractAtlasJson } from '@kinqs/brainrouter-core/dist/atlas/index.js';
import { callOpenAI } from '@kinqs/brainrouter-core/dist/agent/agent.js';
import { syncRequirementPlanTrack } from '@kinqs/brainrouter-core/dist/requirement/planTrackSync.js';
import { ensureProject, getProject, getWorkItem, listWorkItems, createWorkItem, transitionWorkItem, updateWorkItem, addComment, linkWorkItem, createSprint, listSprints, setSprintState, listAutomations, createAutomation, updateAutomation, deleteAutomation, listMembers, addMember, updateMemberRole, removeMember, getGithubLinks, setGithubLink } from '@kinqs/brainrouter-core/dist/track/trackStore.js';
import { exportToGithub, importFromGithub, importMembersFromGithub, resolveGithubConfigForWorkspace, listResolvedGithubConfigsForWorkspace, issueToWorkItem } from '@kinqs/brainrouter-core/dist/track/githubSync.js';
import { scanGitCommitsForTrack } from '@kinqs/brainrouter-core/dist/track/commitScanner.js';
import { readGitTrackContext, startGitWorkForTrackItem } from '@kinqs/brainrouter-core/dist/track/gitWorkflow.js';
import { listConnectorCatalog } from '@kinqs/brainrouter-core/dist/connectors/catalog.js';
import { createConnector, deleteConnector, finishConnectorRun, getConnector, listConnectorRuns, listConnectors, recordConnectorRun, updateConnector } from '@kinqs/brainrouter-core/dist/connectors/connectorStore.js';
import { exportConnectorDefinitions, importConnectorDefinitions } from '@kinqs/brainrouter-core/dist/connectors/definitionTransfer.js';
import { runGithubConnectorCheckpoint, runGithubConnectorPermissionSync, validateGithubConnectorAccess } from '@kinqs/brainrouter-core/dist/connectors/githubConnector.js';
import { countConnectorDocuments, searchConnectorDocuments, upsertConnectorDocuments } from '@kinqs/brainrouter-core/dist/connectors/documentStore.js';
import { exportConnectorDocumentsForMemory } from '@kinqs/brainrouter-core/dist/connectors/memoryBridge.js';
import { countConnectorPermissions, listConnectorPermissions, upsertConnectorPermissions } from '@kinqs/brainrouter-core/dist/connectors/permissionStore.js';
import { retrieveConnectorSlimDocuments } from '@kinqs/brainrouter-core/dist/connectors/slimRetrieval.js';
/**
 * Strip secrets from the `cli` config before it's sent to the renderer (the
 * snapshot's `cliKnobs` is shown verbatim in Settings → Advanced). The GitHub
 * token lives in `cli.track.githubToken` but must never cross to the renderer —
 * the desktop only ever learns whether one is *set*. Returns a shallow-cloned,
 * redacted copy; the on-disk config is untouched.
 */
function scrubCliSecrets(cli) {
    const c = (cli && typeof cli === 'object' ? { ...cli } : {});
    if (c.webSearch && typeof c.webSearch === 'object') {
        const webSearch = { ...c.webSearch };
        if (typeof webSearch.serperApiKey === 'string' && webSearch.serperApiKey)
            webSearch.serperApiKey = '••••';
        if (typeof webSearch.braveApiKey === 'string' && webSearch.braveApiKey)
            webSearch.braveApiKey = '••••';
        if (webSearch.google && typeof webSearch.google === 'object') {
            const google = { ...webSearch.google };
            if (typeof google.apiKey === 'string' && google.apiKey)
                google.apiKey = '••••';
            webSearch.google = google;
        }
        c.webSearch = webSearch;
    }
    if (c.track && typeof c.track === 'object') {
        const track = { ...c.track };
        delete track.githubToken;
        if (Array.isArray(track.githubRepos)) {
            track.githubRepos = track.githubRepos.map((entry) => {
                if (!entry || typeof entry !== 'object')
                    return entry;
                const clean = { ...entry };
                delete clean.token;
                return clean;
            });
        }
        c.track = track;
    }
    return c;
}
function normalizeTrackGithubRepos(track) {
    const byRepo = new Map();
    for (const entry of Array.isArray(track.githubRepos) ? track.githubRepos : []) {
        const repo = typeof entry?.repo === 'string' ? entry.repo.trim() : '';
        if (!repo)
            continue;
        byRepo.set(repo, {
            ...byRepo.get(repo),
            repo,
            token: typeof entry.token === 'string' && entry.token.trim() ? entry.token.trim() : byRepo.get(repo)?.token,
            label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : byRepo.get(repo)?.label,
        });
    }
    const legacyRepo = track.githubRepo?.trim();
    if (legacyRepo) {
        const existing = byRepo.get(legacyRepo);
        const legacyToken = track.githubToken?.trim() || undefined;
        byRepo.set(legacyRepo, { ...existing, repo: legacyRepo, token: existing?.token ?? legacyToken });
    }
    return [...byRepo.values()];
}
function syncLegacyTrackGithubFields(track) {
    const repos = normalizeTrackGithubRepos(track);
    if (repos.length === 0) {
        delete track.githubRepo;
        delete track.githubToken;
        delete track.githubRepos;
        delete track.activeGithubRepo;
        return;
    }
    const activeRepo = track.activeGithubRepo?.trim() || track.githubRepo?.trim() || repos[0].repo;
    const active = repos.find((r) => r.repo === activeRepo) ?? repos[0];
    track.githubRepos = repos;
    track.activeGithubRepo = active.repo;
    track.githubRepo = active.repo;
    if (active.token)
        track.githubToken = active.token;
    else
        delete track.githubToken;
}
function githubIntegrationSnapshot(workspaceRoot) {
    const cfg = resolveGithubConfigForWorkspace(workspaceRoot);
    const repos = listResolvedGithubConfigsForWorkspace(workspaceRoot).map((r) => ({ repo: r.repo, hasToken: r.hasToken, tokenSource: r.tokenSource ?? null, active: r.active, label: r.label, connectorId: r.connectorId, source: r.source }));
    const fresh = loadConfig();
    return { repo: cfg.repo ?? null, hasToken: !!cfg.token, tokenSource: cfg.tokenSource ?? null, repos, caBundle: fresh.cli?.track?.githubCaBundle ?? null };
}
import { isRequirementStatus, isRequirementPriority } from '@kinqs/brainrouter-types';
// ANNOTATION-RECORDS (0.4.15) — durable feedback records store + markdown
// export (shared with the CLI). Thin wrappers below keep all business logic in
// the CLI store; the desktop panel only reads/mutates through these endpoints.
import { listAnnotations, getAnnotation, createAnnotation, setStatus as setAnnotationStatus, addComment as addAnnotationComment, linkAnnotation } from '@kinqs/brainrouter-core/dist/annotation/annotationStore.js';
import { annotationsToMarkdown } from '@kinqs/brainrouter-core/dist/annotation/annotationExport.js';
import { isAnnotationStatus, isAnnotationTargetKind, isAnnotationSeverity, isAnchorStale } from '@kinqs/brainrouter-types';
// ARTIFACT-RECORDS (0.4.15) — durable Artifact Records store (shared with the
// CLI). Thin wrappers below keep all business logic in the CLI store; the
// desktop panel only reads/mutates/previews through these endpoints.
import { listArtifacts, createArtifact, updateArtifact, getArtifact, linkArtifact, revertArtifact } from '@kinqs/brainrouter-core/dist/artifact/artifactStore.js';
import { isArtifactKind, isArtifactStatus, isArtifactFormat } from '@kinqs/brainrouter-types';
import { listWorkers, readWorkerSummary, readWorkerTranscript, readWorkerMeta } from '@kinqs/brainrouter-core/dist/worker/workerStore.js';
import { listSessions } from '@kinqs/brainrouter-core/dist/orchestration/orchestrator.js';
import { readRun } from '@kinqs/brainrouter-core/dist/workflow/workflowRun.js';
import { reconcileStaleBackgroundTasks } from '@kinqs/brainrouter-core/dist/background/backgroundReconcile.js';
import { childSessionKey } from '@kinqs/brainrouter-core/dist/mcp/mcpUtils.js';
import { desktopSessionModePatchFromArgs, mergeSessionModePrefs } from './sessionModeBridge.js';
function createComputerUseBridge(port) {
    if (!port)
        return undefined;
    let seq = 0;
    const pending = new Map();
    const request = (op, action) => {
        const id = `cu_${++seq}`;
        port.postMessage({ kind: 'computer-use-request', id, op, ...(action ? { action } : {}) });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('computer_use timed out waiting for Electron main.'));
            }, 60_000);
            pending.set(id, { resolve: (value) => resolve(value), reject, timer });
        });
    };
    return {
        screenshot: () => request('screenshot'),
        act: (action) => request('act', action),
        handleMessage(message) {
            if (!message || typeof message !== 'object')
                return false;
            const msg = message;
            if (msg.kind !== 'computer-use-response' || typeof msg.id !== 'string')
                return false;
            const entry = pending.get(msg.id);
            if (!entry)
                return true;
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.ok)
                entry.resolve(msg.result);
            else
                entry.reject(new Error(msg.error || 'computer_use failed in Electron main.'));
            return true;
        },
    };
}
const TERM_BUF_CAP = 400_000;
/**
 * DESK-5c — live model list, same endpoint contract as the CLI wizard's
 * fetchOpenAiCompatibleModels (cli/wizard/modelsApi.ts, not imported here
 * because it pulls the ink picker): derive `GET <endpoint>/models` by
 * stripping the trailing /chat/completions, Bearer auth (literal "local"
 * when no key — the LM Studio/Ollama convention), 5s timeout,
 * `{ data: [{ id }] }` response shape.
 */
/** Live model list for an endpoint. Returns the ids plus, on failure, WHY:
 *  `status` is the HTTP status when the server answered (e.g. 401 = bad key,
 *  404 = wrong path), `error: 'unreachable'` when the request never landed
 *  (network / CORS / timeout). The setup dialog uses this to tell a wrong key
 *  apart from an empty catalog. Models is always an array (empty on failure). */
async function fetchEndpointModels(endpoint, apiKey, apiVersion) {
    const chat = (endpoint && endpoint.trim()) || 'https://api.openai.com/v1/chat/completions';
    // Azure-style endpoints need an `?api-version=` on /models too — append it via
    // the same shared helper the chat call uses, so a saved/probed Azure provider
    // can actually list its deployments.
    const modelsUrl = withApiVersion(chat.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '') + '/models', apiVersion);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(modelsUrl, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim() || LOCAL_PLACEHOLDER_KEY}` },
            signal: controller.signal,
        });
        if (!res.ok)
            return { models: [], status: res.status };
        const body = await res.json();
        const ids = [];
        for (const row of body.data ?? []) {
            const id = typeof row.id === 'string' ? row.id : '';
            if (!id)
                continue;
            ids.push(id);
            registerModelReasoningCapabilities(id, inferModelReasoningCapabilities(row));
        }
        // LM Studio's thin OpenAI-compat /v1/models omits reasoning vocab; its
        // native /api/v1/models advertises it. Populate the cache (self-guards for
        // non-LM-Studio endpoints) so binary on/off models are detected and never
        // sent a graded `low`/`high` they would reject. Best-effort; never blocks.
        await refreshLmStudioCache(chat).catch(() => 0);
        return { models: [...new Set(ids)].sort() };
    }
    catch {
        return { models: [], error: 'unreachable' };
    }
    finally {
        clearTimeout(timer);
    }
}
function endpointKey(endpoint) {
    return (endpoint ?? '').replace(/\/+$/, '');
}
function matchingDefaultProvider(providers, llmCfg) {
    if (!providers || !llmCfg)
        return { name: null, modelMatches: false };
    const entries = Object.entries(providers);
    const connectionMatches = (p) => p.provider === llmCfg.provider &&
        endpointKey(p.endpoint) === endpointKey(llmCfg.endpoint) &&
        p.apiKey === llmCfg.apiKey;
    const exact = entries.find(([, p]) => connectionMatches(p) && p.model === llmCfg.model);
    if (exact)
        return { name: exact[0], modelMatches: true };
    const connection = entries.find(([, p]) => connectionMatches(p));
    if (connection)
        return { name: connection[0], modelMatches: false };
    return { name: null, modelMatches: false };
}
/**
 * DESK-5d — a session's resting state, read from the transcript tail:
 * an assistant tail means the turn finished ("done"); a user tail means the
 * turn never completed (interrupted / crashed → "needs a reply"). Tool
 * messages and named-user tool results are skipped, mirroring the
 * transcript renderer. Tail window only — transcripts can be megabytes.
 */
function lastTranscriptRole(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 16_384);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const e = JSON.parse(lines[i]);
                if (e.role === 'assistant')
                    return 'assistant';
                if (e.role === 'user' && !e.name)
                    return 'user';
            }
            catch { /* the tail window may start mid-line */ }
        }
    }
    catch { /* unreadable */ }
    return undefined;
}
/** Parse a persisted ISO `timestamp` to epoch ms; undefined when absent/bad. */
function entryTs(e) {
    if (typeof e.timestamp !== 'string')
        return undefined;
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) ? t : undefined;
}
/** Reconstruct user/assistant prose + tool-group rows from OpenAI-format entries. */
function reconstructTranscriptRows(entries) {
    const rows = [];
    const callMeta = new Map();
    let group = null;
    let groupTs;
    const flush = () => { if (group && group.length)
        rows.push({ kind: 'tool-group', items: group, ts: groupTs }); group = null; groupTs = undefined; };
    const firstLine = (s) => {
        const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
        return line.replace(/\s+/g, ' ').slice(0, 90);
    };
    const summarize = (name, a, content) => {
        const arg = (k) => (typeof a[k] === 'string' ? a[k] : undefined);
        const primary = arg('path') ?? arg('command') ?? arg('query') ?? arg('pattern') ?? arg('url') ?? arg('targetFile');
        if (primary)
            return primary.slice(0, 120);
        return firstLine(content) || '(no output)';
    };
    for (const e of entries) {
        const text = typeof e.content === 'string' ? e.content : '';
        const ts = entryTs(e);
        if (e.role === 'user' && text.trim() && !e.name) {
            flush();
            rows.push({ kind: 'user', text: text.slice(0, 20_000), ts });
        }
        else if (e.role === 'assistant') {
            if (Array.isArray(e.tool_calls)) {
                for (const c of e.tool_calls) {
                    if (!c?.id)
                        continue;
                    let parsed = {};
                    const raw = c.function?.arguments;
                    try {
                        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw ?? {};
                    }
                    catch { /* unparseable */ }
                    callMeta.set(c.id, { name: String(c.function?.name ?? 'tool'), args: parsed });
                }
            }
            if (text.trim()) {
                flush();
                rows.push({ kind: 'assistant', text: text.slice(0, 40_000), ts });
            }
        }
        else if (e.role === 'tool') {
            const meta = e.tool_call_id ? callMeta.get(e.tool_call_id) : undefined;
            const name = e.name ?? meta?.name ?? 'tool';
            const a = meta?.args ?? {};
            const filePath = /edit|write|patch|apply/i.test(name) && typeof a.path === 'string' ? a.path : undefined;
            if (!group)
                group = [];
            groupTs = ts ?? groupTs; // the group's time = its last tool's time
            group.push({ tool: name, summary: summarize(name, a, text), preview: text ? text.slice(0, 3_000) : undefined, ok: !e.isError, file: filePath });
        }
    }
    flush();
    return rows;
}
/**
 * §6 STALE DETECTION — attach a transient `stale` flag to a record whose code
 * anchor (filePath + line range + contentHash) no longer matches the file on
 * disk. Reads the current lines through the SAME safe workspace read the editor
 * uses, slices the anchored range, and re-hashes via {@link isAnchorStale}. Any
 * read failure (missing/binary/oversize) → not stale, so a transient glitch
 * never raises a false alarm. Records with no code-anchor fingerprint pass
 * through untouched.
 */
function annotateStale(workspaceRoot, rec) {
    const anchor = rec.anchor;
    if (!anchor?.filePath || !anchor.contentHash || anchor.startLine === undefined)
        return rec;
    try {
        const entry = readWorkspaceEntry(workspaceRoot, anchor.filePath);
        if (entry.kind !== 'file' || entry.error)
            return rec;
        const lines = entry.content.split('\n');
        const start = Math.max(0, anchor.startLine - 1);
        const end = anchor.endLine !== undefined ? anchor.endLine : anchor.startLine;
        const current = lines.slice(start, end).join('\n');
        return { ...rec, stale: isAnchorStale(anchor, current) };
    }
    catch {
        return rec;
    }
}
/**
 * ANNOTATION-RECORDS — narrow the renderer's loose query args to a typed,
 * guard-validated {@link AnnotationFilter}. Unknown enum values are dropped
 * rather than passed through, so a stale/bad filter just lists everything.
 */
function annotationFilterFromArgs(a) {
    const filter = {};
    if (isAnnotationStatus(a.status))
        filter.status = a.status;
    if (isAnnotationTargetKind(a.targetKind))
        filter.targetKind = a.targetKind;
    if (typeof a.file === 'string' && a.file)
        filter.file = a.file;
    if (typeof a.targetId === 'string' && a.targetId)
        filter.targetId = a.targetId;
    if (typeof a.requirementId === 'string' && a.requirementId)
        filter.requirementId = a.requirementId;
    return Object.keys(filter).length ? filter : undefined;
}
/**
 * ANNOTATION-RECORDS — build an {@link AnnotationAnchor} from loose args, keeping
 * only the meaningful fields. Returns undefined when nothing locational is set
 * (the store then keeps the annotation anchor-less).
 */
function annotationAnchorFromArgs(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const a = raw;
    const anchor = {};
    if (typeof a.filePath === 'string' && a.filePath)
        anchor.filePath = a.filePath;
    if (typeof a.startLine === 'number')
        anchor.startLine = a.startLine;
    if (typeof a.endLine === 'number')
        anchor.endLine = a.endLine;
    if (typeof a.block === 'string' && a.block)
        anchor.block = a.block;
    if (typeof a.selectedText === 'string' && a.selectedText)
        anchor.selectedText = a.selectedText;
    return Object.keys(anchor).length ? anchor : undefined;
}
/**
 * ARTIFACT-RECORDS — narrow the renderer's loose query args to a typed,
 * guard-validated {@link ArtifactFilter}. Unknown enum values are dropped
 * rather than passed through, so a stale/bad filter just lists everything.
 */
function artifactFilterFromArgs(a) {
    const filter = {};
    if (isArtifactKind(a.kind))
        filter.kind = a.kind;
    if (isArtifactStatus(a.status))
        filter.status = a.status;
    if (typeof a.sessionKey === 'string' && a.sessionKey)
        filter.sessionKey = a.sessionKey;
    if (typeof a.requirementId === 'string' && a.requirementId)
        filter.requirementId = a.requirementId;
    return Object.keys(filter).length ? filter : undefined;
}
/**
 * ARTIFACT/ANNOTATION-LINK — default a list filter to the ACTIVE session, so the
 * artifacts/annotations panels show only this chat's records (session-scoped,
 * matching the brain's session-scoped recall). `args.all === true` opts back
 * into the whole-workspace view.
 */
function withSessionScope(filter, args, sessionKey) {
    if (args.all === true || !sessionKey)
        return filter;
    return { ...(filter ?? {}), sessionKey: filter?.sessionKey ?? sessionKey };
}
/**
 * DESK-5w — map a WORKER's event-log transcript (a different shape from the
 * OpenAI-format one: {role:'system'|'tool'|'assistant', event, tool, content})
 * to the same row shape, so a worker reads like a chat too. The spawn goal
 * becomes the opening "user" turn.
 */
function workerEventsToRows(entries) {
    const rows = [];
    let group = null;
    let groupTs;
    const flush = () => { if (group && group.length)
        rows.push({ kind: 'tool-group', items: group, ts: groupTs }); group = null; groupTs = undefined; };
    for (const e of entries) {
        const role = String(e.role ?? '');
        const event = String(e.event ?? '');
        const content = typeof e.content === 'string' ? e.content : '';
        const ts = entryTs(e) ?? (typeof e.ts === 'string' ? (Number.isFinite(Date.parse(e.ts)) ? Date.parse(e.ts) : undefined) : undefined);
        if (role === 'system' && event === 'spawn') {
            flush();
            const goal = typeof e.goal === 'string' ? e.goal : '';
            if (goal)
                rows.push({ kind: 'user', text: goal.slice(0, 20_000), ts });
        }
        else if (role === 'tool' && event === 'end') {
            if (!group)
                group = [];
            groupTs = ts ?? groupTs;
            group.push({ tool: String(e.tool ?? 'tool'), summary: typeof e.summary === 'string' ? e.summary : '', ok: e.ok !== false });
        }
        else if ((role === 'assistant' || (role === 'user' && !e.name)) && content.trim()) {
            // role:'user' WITH a name is an injected system/guard message — hide it.
            flush();
            rows.push({ kind: role === 'user' ? 'user' : 'assistant', text: content.slice(0, 40_000), ts });
        }
    }
    flush();
    return rows;
}
/**
 * DESK-6t — run a git command ASYNCHRONOUSLY and return stdout (captured even on
 * a non-zero exit — e.g. `git diff --no-index` exits 1 with the diff on stdout).
 * Async (execFile, not execFileSync) so a slow `git` never blocks the host's
 * single message loop and stall an unrelated New-chat / resume command behind it.
 */
function git(args, cwd, opts) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, encoding: 'utf-8', timeout: opts?.timeout ?? 5_000, maxBuffer: opts?.maxBuffer ?? 8_000_000 }, (_err, stdout) => resolve(String(stdout ?? '')));
    });
}
/** Sidebar row payload: transcript summary + the status the icons render. */
function sessionRows(root, limit) {
    return listTranscripts(root, { limit }).map((s) => {
        const file = s.sessionDir
            ? path.join(s.sessionDir, s.fileName)
            : path.join(getStateDir(root), 'transcripts', s.fileName);
        return { ...s, lastRole: lastTranscriptRole(file) };
    });
}
export async function main(transport) {
    const workspaceRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || process.cwd();
    // DESK-6w (T4) — resolve how this workspace relates to its owning git repo
    // once (repo name, owning git root, subdir-vs-root). Workspace-scoped status/
    // diff run in workspaceRoot with a `-- .` pathspec: that limits results to the
    // workspace subtree (so a monorepo subfolder or a nested clone inside the repo
    // never pulls in unrelated parent changes) AND keeps paths workspace-relative
    // for the renderer. `workspaceGitScope` is for repo-root ops (worktrees) later.
    const wsGit = resolveWorkspaceGit(workspaceRoot);
    const fileListCache = new WorkspaceFileListCache();
    const listWorkspaceFilesCached = async (args) => {
        const refresh = args.refresh === true || args.force === true;
        const cached = refresh ? null : fileListCache.get(workspaceRoot);
        if (cached)
            return cached;
        const generatedAt = Date.now();
        const tracked = await git(['ls-files'], workspaceRoot);
        const untracked = await git(['ls-files', '--others', '--exclude-standard'], workspaceRoot);
        const all = [...new Set((tracked + '\n' + untracked).split('\n').filter(Boolean))].sort();
        const result = all.length > 0
            ? { files: all.slice(0, 3000), truncated: all.length > 3000, source: 'git', generatedAt }
            : { ...listWorkspaceFiles(workspaceRoot, { limit: 3000 }), generatedAt };
        if (result.error)
            return result;
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
        if (orphaned > 0)
            console.error(`[brainrouter-desktop host] reconciled ${orphaned} orphaned durable task(s) on boot`);
    }
    catch { /* best-effort */ }
    // utilityProcess gives us process.parentPort; plain `node host.js` (dev
    // smoke) falls back to a console sink so the bootstrap is runnable solo.
    const port = process.parentPort;
    // Transport seam: an injected transport (the mobile WS adapter) wins; else the
    // Electron parentPort; else a console sink (dev smoke).
    const send = transport
        ? transport.send
        : port
            ? (msg) => port.postMessage(msg)
            : (msg) => console.log(JSON.stringify(msg));
    const computerUseBridge = createComputerUseBridge(port);
    // Identical boot recipe to `brainrouter chat` (index.ts): config → llm →
    // pool.connectAll(profiles) → Agent. Offline MCP does not block (same
    // semantics as the CLI's non-strict mode).
    const config = loadConfig();
    let llm = config.llm || { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
    const mcpClient = new McpClientPool();
    try {
        await mcpClient.connectAll(config.servers ?? {}, llm, { timeoutMs: 5_000 });
        mcpClient.startReconnectSupervisor(); // WS9 — auto-reconnect dropped MCP servers in the background
    }
    catch { /* offline-mode: local tools only, same as the CLI */ }
    // REMOTE-BRAIN Phase 3d — call a brain Atlas tool via the MCP pool, parsing its
    // JSON text result. Best-effort: null on any failure so the local artifact path
    // always remains the fallback.
    const callBrainAtlas = async (tool, args) => {
        try {
            const res = await mcpClient.callTool(tool, args);
            if (!res || res.isError)
                return null;
            const text = res?.content?.[0]?.text;
            return typeof text === 'string' && text.trim() ? JSON.parse(text) : null;
        }
        catch {
            return null;
        }
    };
    // DESK-3 — the approval/choice port: agent asks become interaction-request
    // events; the renderer's dialogs answer them. Shares the hostCore broker so
    // interrupt/shutdown dismiss pending dialogs fail-closed.
    const broker = new InteractionBroker();
    // DESK-5v — interaction-request events ride a separate seq namespace AND
    // carry the ASKING agent's own sessionKey, so an approval raised by a
    // background turn surfaces against the right chat (same `send` wire).
    let portSeq = 1_000_000; // offset so port events never collide with core seq
    const emitPortFor = (sessionKey, e) => send({ seq: ++portSeq, ts: Date.now(), sessionKey, event: e });
    // EXTENSIONS — activate code-level extensions before the first turn (workspace
    // tier gated on project trust). Best-effort; never blocks the host boot.
    await loadExtensions(workspaceRoot).catch(() => undefined);
    const agent = new Agent(mcpClient, llm, {
        workspaceRoot,
        launchCwd: workspaceRoot,
        interactionPort: createBrokerPort(broker, (e) => emitPortFor(agent.sessionKey, e)),
        computerUsePort: computerUseBridge,
    });
    // DESK-5v — the agent the user is currently VIEWING. hostCore keeps a pool of
    // agents (one per running/active session) and tells us which is active via
    // onActiveAgentChange; every read-only query below reports THIS agent so the
    // ring/tokens/recap/transcript track the chat on screen, not a background one.
    let activeAgent = agent;
    const loadGlobalLlm = () => {
        const fresh = loadConfig();
        llm = fresh.llm ?? llm;
        return llm;
    };
    const llmForSession = (sessionKey) => resolveSessionLlmConfig(loadGlobalLlm(), workspaceRoot, sessionKey);
    const syncActiveSessionLlm = (base = loadGlobalLlm()) => {
        const next = resolveSessionLlmConfig(base, workspaceRoot, activeAgent.sessionKey);
        activeAgent.setLLMConfig(next);
        return next;
    };
    // DESK-5v — an independent agent for a SECOND, concurrent session: shares the
    // one MCP pool / llm / broker but keeps its own history, counters and key, so
    // two chats can run turns at the same time.
    // Item 10 — the global runtime is the config.json LLM; a session can override
    // provider/model/endpoint (sessionRuntimeStore). spawnAgent resolves THIS
    // session's runtime so concurrent chats can run different models/providers.
    const spawnAgent = (sessionKey) => {
        const a = new Agent(mcpClient, llmForSession(sessionKey), {
            workspaceRoot,
            launchCwd: workspaceRoot,
            interactionPort: createBrokerPort(broker, (e) => emitPortFor(a.sessionKey, e)),
            computerUsePort: computerUseBridge,
        });
        a.sessionKey = sessionKey;
        return a;
    };
    // §6 — the local reviewer runs in an ISOLATED, READ-ONLY, NON-PROMPTING agent:
    //  - a deny-all interaction port (confirm→false, choice→null) that NEVER emits
    //    an interaction-request to the UI, so review can't pop an approval dialog;
    //  - read access mode (look-only: no file writes, no shell, no mutating tools).
    // Its review: sessionKey is filtered from the picker. Even if the model ignores
    // the "don't call tools" instruction, it fails closed instead of prompting.
    const spawnReviewer = (sessionKey) => {
        const a = new Agent(mcpClient, llmForSession('review'), {
            workspaceRoot,
            launchCwd: workspaceRoot,
            interactionPort: { confirm: async () => false, choice: async () => null },
        });
        // A STABLE per-task `review:<id>` key (filtered from the picker by
        // isInternalSessionKey) so the reviewer's turn transcript is durably
        // findable as the task's conversation; falls back to a timestamp key.
        a.sessionKey = sessionKey ?? `review:${Date.now().toString(36)}`;
        try {
            a.setAccessMode?.('read');
        }
        catch { /* older agent */ }
        return a;
    };
    // A WRITE-capable background agent for a plan revision: its own internal
    // session key (filtered from the picker) so its turn transcript is the task's
    // conversation, but its `update_plan` is intercepted (onPlanUpdate) and the
    // host writes the result into the USER's session plan. Non-prompting.
    const spawnTaskAgent = (sessionKey, access) => {
        const a = new Agent(mcpClient, llmForSession(sessionKey), {
            workspaceRoot,
            launchCwd: workspaceRoot,
            interactionPort: { confirm: async () => false, choice: async () => null },
        });
        a.sessionKey = sessionKey;
        try {
            a.setAccessMode?.(access);
        }
        catch { /* older agent */ }
        return a;
    };
    const activeMemorySessionKey = () => activeAgent?.sessionKey ?? agent.sessionKey;
    const lifecycleActionFor = (change) => {
        const c = change.toLowerCase();
        if (c === 'created')
            return 'created';
        if (c.includes('status'))
            return 'status-changed';
        if (c.includes('comment'))
            return 'comment-added';
        if (c.includes('saved'))
            return 'saved';
        if (c.includes('export'))
            return 'exported';
        return 'updated';
    };
    const emitRecordEvent = (event) => {
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
    const taskEventView = (t) => ({
        id: t.id, kind: t.kind, status: t.status, title: t.title,
        workspaceRoot, sessionKey: t.sessionKey,
        requirementId: t.requirementId, planId: t.planId, artifactId: t.artifactId, attachmentId: t.attachmentId,
        transcript: t.transcript, phase: currentPhase(t), error: t.error,
        createdAt: t.createdAt, startedAt: t.startedAt, updatedAt: t.updatedAt, completedAt: t.completedAt,
    });
    const emitTaskEvent = (action, t) => {
        send({ seq: ++portSeq, ts: Date.now(), sessionKey: t.sessionKey, event: { kind: 'task-event', action, task: taskEventView(t) } });
    };
    /** Append a progress phase + emit the live update in one step. */
    const taskProgress = (id, phase, note) => {
        const t = appendTaskProgress(workspaceRoot, id, { phase, note });
        if (t)
            emitTaskEvent('progress', t);
    };
    // VERIFICATION SCOPING (workflow-gaps follow-up) — surface the build/test/
    // typecheck/lint commands a MAIN turn runs as durable `verification` tasks,
    // keyed by THIS host's workspaceRoot + the turn's sessionKey + the task id.
    // Because the work runs inside the turn (which the host pool keeps alive on a
    // workspace switch), the verification keeps running in the edited workspace and
    // the task stays visible for that workspace even while another is active —
    // clicking it reopens the command + output. We match a run_command's
    // tool-start→tool-end by callId. Best-effort throughout.
    const verifyTitle = (command) => {
        const head = command.replace(/\s+/g, ' ').trim();
        return `Verify — ${head.length > 64 ? `${head.slice(0, 63)}…` : head}`;
    };
    const verifyTasksByCall = new Map();
    // §goal-autonomy — consecutive prose-only "strikes" per session (anti-spin),
    // mirroring the CLI Ink loop's goalNoToolStrikes counter.
    const goalStrikes = new Map();
    const observeVerificationEvent = (sessionKey, event) => {
        if (event.kind === 'tool-start') {
            if (event.tool !== 'run_command' || !event.callId)
                return;
            const command = typeof event.args?.command === 'string' ? event.args.command : '';
            if (!command || classifyForVerification('run_command', command) !== 'verified')
                return;
            const task = createBackgroundTask(workspaceRoot, { kind: 'verification', title: verifyTitle(command), sessionKey, status: 'running' });
            const verifyKey = `internal:verify:${task.id}`;
            const withTranscript = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: verifyKey } }) ?? task;
            verifyTasksByCall.set(event.callId, { taskId: task.id, verifyKey, command });
            try {
                appendTranscriptEntry(workspaceRoot, verifyKey, { role: 'user', content: `$ ${command}` });
            }
            catch { /* advisory */ }
            taskProgress(task.id, 'running', command.slice(0, 80));
            emitTaskEvent('created', withTranscript);
            recordTelemetry({ name: TELEMETRY_EVENTS.task_started, workspaceRoot, sessionKey, taskKind: 'verification' });
        }
        else if (event.kind === 'tool-end') {
            if (!event.callId)
                return;
            const entry = verifyTasksByCall.get(event.callId);
            if (!entry)
                return;
            verifyTasksByCall.delete(event.callId);
            const ok = event.ok;
            const output = String(event.preview || event.summary || '').slice(0, 8_000);
            try {
                appendTranscriptEntry(workspaceRoot, entry.verifyKey, { role: 'assistant', content: `${ok ? '✓ passed' : '✗ failed'}\n\n${output}` });
            }
            catch { /* advisory */ }
            const done = updateBackgroundTask(workspaceRoot, entry.taskId, {
                status: ok ? 'completed' : 'failed',
                error: ok ? undefined : (event.summary || 'Verification failed.'),
                result: { ok, command: entry.command, summary: event.summary },
            });
            if (done)
                emitTaskEvent(ok ? 'completed' : 'failed', done);
            recordTelemetry({ name: ok ? TELEMETRY_EVENTS.task_completed : TELEMETRY_EVENTS.task_failed, workspaceRoot, sessionKey, taskKind: 'verification', ok });
        }
    };
    const captureRequirementNote = async (record, change) => {
        let memoryId;
        try {
            memoryId = (await emitAgentEvent({ mcpClient, sessionKey: activeMemorySessionKey() }, {
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
            })) ?? undefined;
            if (memoryId)
                linkRequirement(workspaceRoot, record.id, { memoryId });
        }
        catch { /* advisory — never break the desktop action */ }
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
    const captureAnnotationNote = async (record, change) => {
        let memoryId;
        try {
            memoryId = (await emitAnnotationCapture({ mcpClient, sessionKey: activeMemorySessionKey() }, {
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
            })) ?? undefined;
            if (memoryId)
                linkAnnotation(workspaceRoot, record.id, { memoryId });
        }
        catch { /* advisory — never break the desktop action */ }
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
    const captureAnnotationExportNote = async (records) => {
        if (records.length === 0)
            return;
        try {
            const memoryId = await emitAgentEvent({ mcpClient, sessionKey: activeMemorySessionKey() }, {
                kind: 'agent_output',
                summary: `Annotation export — ${records.length} annotation(s) returned to session`,
                payload: {
                    exported: records.length,
                    annotationIds: records.map((r) => r.id),
                    markdown: annotationsToMarkdown(records),
                },
            });
            if (memoryId) {
                for (const record of records)
                    linkAnnotation(workspaceRoot, record.id, { memoryId });
            }
        }
        catch { /* advisory — never break the desktop action */ }
    };
    const captureArtifactNote = async (record, change) => {
        let memoryId;
        try {
            memoryId = (await emitArtifactCapture({ mcpClient, sessionKey: activeMemorySessionKey() }, {
                artifactId: record.id,
                title: record.title,
                summary: record.summary,
                artifactKind: record.kind,
                format: record.format,
                status: record.status,
                requirementId: record.requirementId,
                taskId: record.taskId,
            })) ?? undefined;
            if (memoryId)
                linkArtifact(workspaceRoot, record.id, { memoryId });
        }
        catch { /* advisory — never break the desktop action */ }
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
    // DESK-5c — terminal session registry + endpoint-models cache.
    const terms = new Map();
    let termSeq = 0;
    // Per-endpoint /models cache ('' = the active llm; otherwise a named provider).
    const modelsCacheByKey = new Map();
    // DESK-5d — PR state cache (gh is a network call; the sidebar refreshes often).
    let prCache = null;
    // §session-pr — cached all-states PR rows (number/state/headRefName/isDraft/
    // mergeable) used to match each session to its PR; ~60s TTL, polled by the
    // renderer on its existing 25s cadence.
    let prStatusMapCache = null;
    // Short-lived dedup cache for the FULL agent-continuation read (loadHistory).
    // The context-fill estimate no longer reads this (it uses transcriptSizeBytes),
    // so there's no O(n) token loop here anymore.
    const transcriptCache = new Map();
    const readTranscriptCached = (key) => {
        const now = Date.now();
        const hit = transcriptCache.get(key);
        if (hit && now - hit.at < 3_000)
            return hit.entries;
        const entries = loadTranscript(workspaceRoot, key);
        transcriptCache.set(key, { entries, at: now });
        if (transcriptCache.size > 8)
            transcriptCache.delete(transcriptCache.keys().next().value);
        return entries;
    };
    // Review v2 helpers (shared by the review-* queries + the commit/push gate).
    const isoNow = () => new Date().toISOString();
    const collectWorkingDiff = async () => {
        const changed = (await git(['status', '--porcelain', '--', '.'], workspaceRoot)).split('\n').filter(Boolean).slice(0, 30);
        const files = changed.map((l) => l.slice(3).trim());
        let diff = '';
        for (const f of files) {
            if (diff.length > 60_000)
                break;
            let d = await git(['diff', 'HEAD', '--', f], workspaceRoot, { maxBuffer: 4_000_000 });
            if (!d.trim())
                d = await git(['diff', '--no-index', '--', '/dev/null', f], workspaceRoot, { maxBuffer: 4_000_000 });
            diff += `\n# ${f}\n${d.slice(0, 12_000)}`;
        }
        return { diff, files };
    };
    // Map the model's free-form severities onto the v2 scale.
    const SEV_MAP = { security: 'critical', critical: 'critical', bug: 'high', high: 'high', perf: 'medium', medium: 'medium', style: 'low', nit: 'low', low: 'low', info: 'info' };
    // Instrumented so the review runs as a VISIBLE background task: `onPhase`
    // streams diff-collection → analysis → findings → verification → completion to
    // the durable task; `reviewerKey` makes the reviewer's turn transcript durably
    // findable as the task's conversation.
    const runReview = async (ctx) => {
        const phase = ctx?.onPhase ?? (() => { });
        phase('collecting-diff');
        const { diff, files } = await collectWorkingDiff();
        const base = {
            id: `rev_${Date.now().toString(36)}`, workspaceRoot, repoRoot: wsGit.gitRoot ?? workspaceRoot,
            baseRef: 'HEAD', headRef: 'WORKTREE', diffHash: hashDiff(diff), createdAt: isoNow(), updatedAt: isoNow(),
            status: 'completed', summary: '', findings: [],
        };
        if (files.length === 0) {
            phase('completed', 'no working-tree changes');
            const r = { ...base, summary: 'No working-tree changes to review.' };
            saveReview(workspaceRoot, r);
            return { ...r, files: 0 };
        }
        phase('analyzing', `${files.length} file(s)`);
        const prompt = `You are reviewing the uncommitted changes in this workspace before a commit/PR. Focus on real bugs, security issues, and performance problems introduced by the diff. Be concise.\n\nDiff:\n${diff.slice(0, 60_000)}\n\n${REVIEW_OUTPUT_CONTRACT}`;
        // §6 — isolated, read-only, non-prompting reviewer (review: session filtered).
        // It runs under a `:raw` sub-key so its turn (a 60KB diff prompt + raw JSON
        // findings) does NOT pollute the task's CURATED transcript — runReviewTask
        // writes clean, human-readable progress entries to the task key instead.
        const reviewer = spawnReviewer(ctx?.reviewerKey ? `${ctx.reviewerKey}:raw` : undefined);
        const noop = () => { };
        const cb = { onStatusUpdate: noop, onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop, onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop };
        let answer = '';
        try {
            answer = await reviewer.runTurn(prompt, cb);
        }
        catch (err) {
            phase('failed', err instanceof Error ? err.message : String(err));
            const r = { ...base, status: 'failed', summary: `Review failed: ${err instanceof Error ? err.message : String(err)}` };
            saveReview(workspaceRoot, r);
            return { ...r, files: files.length };
        }
        phase('findings', 'parsing reviewer output');
        const findings = parseReviewFindings(answer).map((f, i) => ({
            id: `f${i}_${Date.now().toString(36)}`, file: f.file, line: f.line ?? undefined, endLine: f.endLine ?? undefined,
            severity: SEV_MAP[String(f.severity ?? '').toLowerCase()] ?? 'medium',
            confidence: f.confidence ?? 70, summary: f.summary,
            details: f.details, suggestion: f.suggestion, codeExcerpt: f.codeExcerpt, diffHunk: f.diffHunk,
            patch: f.patch, status: 'open', canApply: !!f.patch, source: 'ai-review',
        }));
        // Strip the model's <think> reasoning so it never shows as the summary; when
        // there are no findings the empty-state covers it, so leave the summary blank.
        const visible = stripReasoning(answer).split('```')[0].trim();
        const summary = findings.length === 0 ? '' : (visible.slice(0, 400) || `${findings.length} finding(s) across ${files.length} file(s).`);
        const run = { ...base, summary, findings };
        saveReview(workspaceRoot, run);
        phase('completed', `${findings.length} finding(s) across ${files.length} file(s)`);
        return { ...run, files: files.length };
    };
    // §2 (workflow gaps) — Review/Re-run review as a VISIBLE durable task. Creates
    // the task, streams phase progress, persists the reviewer transcript (via the
    // stable reviewer key), writes findings + memory provenance + telemetry, and
    // returns the run so the renderer's review panel still paints as before.
    const runReviewTask = async (sessionKey) => {
        const task = createBackgroundTask(workspaceRoot, { kind: 'review', title: 'Review working changes', sessionKey, status: 'running' });
        const reviewerKey = `review:${task.id}`;
        const withTranscript = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: reviewerKey } }) ?? task;
        emitTaskEvent('created', withTranscript);
        recordTelemetry({ name: TELEMETRY_EVENTS.review_started, workspaceRoot, sessionKey, taskKind: 'review' });
        // §review-visibility — SEED the curated task transcript synchronously so
        // clicking the running task immediately shows the agent at work (not a blank
        // pane while the long review turn computes), then mirror each phase as a
        // readable line. The reviewer's raw turn writes to `${reviewerKey}:raw`.
        const seedReviewTranscript = (role, content) => {
            try {
                appendTranscriptEntry(workspaceRoot, reviewerKey, { role, content });
            }
            catch { /* advisory */ }
        };
        const REVIEW_PHASE_LABELS = {
            'collecting-diff': '📂 Collecting the working-tree diff…',
            analyzing: '🔍 Analyzing the changed files for bugs, security, and performance issues…',
            findings: '📝 Parsing the review findings…',
        };
        seedReviewTranscript('user', 'Review the uncommitted working-tree changes for bugs, security issues, and performance problems.');
        const startedAt = Date.now();
        let run;
        try {
            run = await runReview({ reviewerKey, onPhase: (p, n) => {
                    taskProgress(task.id, p, n);
                    const label = REVIEW_PHASE_LABELS[p];
                    if (label)
                        seedReviewTranscript('assistant', n ? `${label} (${n})` : label);
                } });
            seedReviewTranscript('assistant', run.findings.length === 0
                ? `✅ Review complete — no issues found across ${run.files} file(s).`
                : `✅ Review complete — ${run.findings.length} finding(s) across ${run.files} file(s). See the Review panel for details.`);
        }
        catch (err) {
            seedReviewTranscript('assistant', `❌ Review failed: ${err instanceof Error ? err.message : String(err)}`);
            const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
            if (failed)
                emitTaskEvent('failed', failed);
            recordTelemetry({ name: TELEMETRY_EVENTS.review_completed, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
        // Memory provenance for the review run + its findings (best-effort).
        try {
            const memoryId = await emitAgentEvent({ mcpClient, sessionKey }, {
                kind: 'agent_output',
                summary: `Review ${run.id} — ${run.findings.length} finding(s) across ${run.files} file(s) [${run.status}]`,
                payload: {
                    reviewId: run.id, status: run.status, files: run.files,
                    findings: run.findings.map((f) => ({ id: f.id, file: f.file, line: f.line, severity: f.severity, summary: f.summary })),
                },
            });
            if (memoryId)
                linkBackgroundTaskMemory(workspaceRoot, task.id, memoryId);
        }
        catch { /* advisory — never break the review */ }
        const ok = run.status !== 'failed';
        const done = updateBackgroundTask(workspaceRoot, task.id, {
            status: ok ? 'completed' : 'failed',
            error: ok ? undefined : (run.summary || 'Review failed.'),
            result: { reviewId: run.id, findings: run.findings.length, files: run.files, status: run.status },
        });
        if (done)
            emitTaskEvent(ok ? 'completed' : 'failed', done);
        recordTelemetry({ name: TELEMETRY_EVENTS.review_completed, workspaceRoot, sessionKey, ok, durationMs: Date.now() - startedAt, props: { findings: run.findings.length, files: run.files } });
        return { ...run, taskId: task.id };
    };
    const reviewSnapshot = async () => {
        const { diff, files } = await collectWorkingDiff();
        const diffHash = hashDiff(diff);
        let run = getLatestReview(workspaceRoot);
        if (run) {
            const staled = staleIfDiffChanged(run, diffHash);
            if (staled !== run) {
                saveReview(workspaceRoot, staled);
                run = staled;
            }
        }
        return { run, gate: reviewGate(run, diffHash), diffHash, files: files.length };
    };
    const runPlanRevisionTask = (sessionKey, decision, feedback) => {
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
                let revised = null;
                const cb = {
                    onStatusUpdate: (text) => { if (text)
                        taskProgress(task.id, 'working', text.slice(0, 80)); },
                    onToolStart: () => { }, onToolEnd: () => { }, onAssistantDelta: () => { },
                    onAssistantTurnStart: () => { }, onAssistantTurnEnd: () => { }, onReasoningDelta: () => { }, onUsageUpdate: () => { },
                    onPlanUpdate: (items, explanation) => { revised = { items, explanation }; },
                };
                const prompt = `The implementation plan below was NOT approved.\n\nRequested changes:\n${feedback}\n\nCurrent plan:\n${formatPlan(planBefore)}\n\nRevise the plan to fully address the requested changes, then call \`update_plan\` with the corrected, ordered plan (each item { step, status }, at most one in_progress). Do not implement anything — only produce the revised plan.`;
                await reviser.runTurn(prompt, cb);
                taskProgress(task.id, 'writing-plan');
                const result = revised;
                if (result && Array.isArray(result.items) && result.items.length > 0) {
                    const next = updatePlan(workspaceRoot, { plan: result.items, explanation: result.explanation, requirementId: planBefore.requirementId }, sessionKey);
                    // Version history: snapshot the revised plan as a `revised` decision.
                    const revDecision = recordPlanDecision(workspaceRoot, sessionKey, { verdict: 'revised', planSnapshot: next.items, explanation: next.explanation, requirementId: next.requirementId });
                    // Repaint the USER's Plan panel with the revised plan (the feedback
                    // returns to the same active session).
                    send({ seq: ++portSeq, ts: Date.now(), sessionKey, event: { kind: 'plan-update', items: next.items.map((i) => ({ step: i.step, status: i.status, acceptance: i.acceptance })), explanation: next.explanation } });
                    let memoryId;
                    try {
                        memoryId = (await emitAgentEvent({ mcpClient, sessionKey }, {
                            kind: 'agent_output',
                            summary: `Plan revised (${revDecision.id}) addressing requested changes — ${next.items.length} item(s)`,
                            payload: { planDecisionId: revDecision.id, sourceDecisionId: decision.id, verdict: 'revised', itemCount: next.items.length, feedback },
                        })) ?? undefined;
                        if (memoryId) {
                            linkPlanDecision(workspaceRoot, sessionKey, revDecision.id, memoryId);
                            linkBackgroundTaskMemory(workspaceRoot, task.id, memoryId);
                        }
                    }
                    catch { /* advisory */ }
                    const done = updateBackgroundTask(workspaceRoot, task.id, { status: 'completed', result: { items: next.items.length, revisedDecisionId: revDecision.id } });
                    if (done)
                        emitTaskEvent('completed', done);
                    recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_completed, workspaceRoot, sessionKey, ok: true, durationMs: Date.now() - startedAt, props: { items: next.items.length } });
                }
                else {
                    const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: 'The revision produced no updated plan. Request changes again with more specific feedback.' });
                    if (failed)
                        emitTaskEvent('failed', failed);
                    recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_completed, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt });
                }
            }
            catch (err) {
                const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
                if (failed)
                    emitTaskEvent('failed', failed);
                recordTelemetry({ name: TELEMETRY_EVENTS.plan_revision_completed, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
            }
        })();
        return created;
    };
    let ghEnvCache = null;
    const ghEnv = async () => {
        const now = Date.now();
        if (ghEnvCache && now - ghEnvCache.at < 60_000)
            return ghEnvCache.env;
        const track = (loadConfig().cli?.track) ?? {};
        const configuredCA = track.githubCaBundle?.trim() || undefined;
        const [sslCAInfo, sslCAPath] = await Promise.all([
            git(['config', '--get', 'http.sslCAInfo'], workspaceRoot),
            git(['config', '--get', 'http.sslCAPath'], workspaceRoot),
        ]);
        const env = mergeGithubCliEnv(process.env, {
            sslCAInfo: configuredCA || sslCAInfo.trim() || undefined,
            sslCAPath: sslCAPath.trim() || undefined,
        });
        ghEnvCache = { at: now, env };
        return env;
    };
    const ghText = async (args, opts) => new Promise((resolve) => {
        ghEnv().then((env) => {
            execFile('gh', args, { cwd: workspaceRoot, env, encoding: 'utf-8', timeout: opts?.timeout ?? 10_000, maxBuffer: opts?.maxBuffer ?? 2_000_000 }, (err, stdout, stderr) => {
                const stderrText = String(stderr ?? '');
                resolve({
                    ok: !err,
                    stdout: String(stdout ?? ''),
                    stderr: stderrText,
                    error: err ? normalizeGithubCliError(stderrText, `gh ${args.slice(0, 2).join(' ')} failed.`) : undefined,
                });
            });
        }).catch((err) => resolve({ ok: false, stdout: '', stderr: String(err instanceof Error ? err.message : err), error: String(err instanceof Error ? err.message : err) }));
    });
    const ghJson = async (args, opts) => {
        const res = await ghText(args, opts);
        let data;
        if (res.stdout.trim()) {
            try {
                data = JSON.parse(res.stdout);
            }
            catch {
                return { error: 'GitHub CLI returned invalid JSON.' };
            }
        }
        if (!res.ok && !(opts?.allowNonZeroJson && data !== undefined))
            return { error: res.error ?? 'GitHub CLI command failed.' };
        if (data !== undefined)
            return { data };
        if (!res.ok)
            return { error: res.error ?? 'GitHub CLI command failed.' };
        try {
            return { data: JSON.parse(res.stdout) };
        }
        catch {
            return { error: 'GitHub CLI returned invalid JSON.' };
        }
    };
    const githubApiBase = (connector) => {
        const raw = typeof connector.config?.baseUrl === 'string' ? connector.config.baseUrl.trim() : '';
        return (raw || 'https://api.github.com').replace(/\/+$/, '');
    };
    const githubStaticToken = (connector) => {
        if (connector.credential?.mode !== 'static')
            return {};
        const ref = connector.credential.ref?.trim();
        if (!ref)
            return { error: 'Static GitHub connector credential reference is required.' };
        const token = process.env[ref]?.trim();
        if (!token)
            return { error: `Static GitHub connector credential ${ref} is not available in the host environment.` };
        return { token };
    };
    const githubTokenJson = async (connector, token, apiPath) => {
        const res = await fetch(`${githubApiBase(connector)}${apiPath}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'BrainRouter-Desktop',
            },
        });
        if (!res.ok) {
            let detail = '';
            try {
                const body = await res.json();
                detail = body.message ? `: ${body.message}` : '';
            }
            catch {
                detail = '';
            }
            throw new Error(`GitHub API ${res.status}${detail}`);
        }
        return await res.json();
    };
    const currentGitBranch = async () => {
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
        return branch && branch !== 'HEAD' ? branch : null;
    };
    const trackItemForBranch = (branch) => listWorkItems(workspaceRoot).find((item) => item.codeLinks.some((link) => link.kind === 'branch' && link.ref === branch));
    const readTrackPrStatus = async () => {
        const branch = await currentGitBranch();
        const item = branch ? trackItemForBranch(branch) : undefined;
        const detail = await ghJson(['pr', 'view', '--json', 'number,state,title,url,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup'], { timeout: 8_000 });
        if (detail.error)
            return { pr: null, branch, itemKey: item?.key, error: detail.error };
        return { pr: detail.data ?? null, branch, itemKey: item?.key };
    };
    const githubGhValidationClient = () => ({
        async listRepositories(owner, opts) {
            const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
            const listed = await ghJson(['repo', 'list', owner, '--limit', String(limit), '--json', 'nameWithOwner'], { timeout: 12_000, maxBuffer: 500_000 });
            if (listed.error)
                throw new Error(listed.error);
            return (listed.data ?? []).map((repo) => repo.nameWithOwner ?? '').filter(Boolean);
        },
        async getRepository(repo) {
            const view = await ghJson(['repo', 'view', repo, '--json', 'nameWithOwner'], { timeout: 10_000, maxBuffer: 500_000 });
            if (view.error)
                throw new Error(view.error);
            return view.data?.nameWithOwner ?? repo;
        },
    });
    const githubTokenValidationClient = (connector, token) => ({
        async listRepositories(owner, opts) {
            const limit = Math.max(1, Math.min(100, opts?.limit ?? 100));
            try {
                const orgRepos = await githubTokenJson(connector, token, `/orgs/${encodeURIComponent(owner)}/repos?per_page=${limit}`);
                if (orgRepos.length)
                    return orgRepos.map((repo) => repo.full_name ?? '').filter(Boolean);
            }
            catch {
                // Fall through to the user endpoint; the owner may be a personal account.
            }
            const userRepos = await githubTokenJson(connector, token, `/users/${encodeURIComponent(owner)}/repos?per_page=${limit}`);
            return userRepos.map((repo) => repo.full_name ?? '').filter(Boolean);
        },
        async getRepository(repo) {
            const data = await githubTokenJson(connector, token, `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`);
            return data.full_name ?? repo;
        },
    });
    const githubGhPermissionClient = () => ({
        async listRepositories(owner, opts) {
            const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
            const listed = await ghJson(['repo', 'list', owner, '--limit', String(limit), '--json', 'nameWithOwner'], { timeout: 20_000, maxBuffer: 4_000_000 });
            if (listed.error)
                throw new Error(listed.error);
            return (listed.data ?? []).map((repo) => repo.nameWithOwner ?? '').filter(Boolean);
        },
        async listCollaborators(repo) {
            const collaborators = await ghJson(['api', `repos/${repo}/collaborators?affiliation=all&per_page=100`], { timeout: 20_000, maxBuffer: 4_000_000 });
            if (collaborators.error)
                throw new Error(collaborators.error);
            return (collaborators.data ?? [])
                .filter((collaborator) => typeof collaborator.login === 'string' && collaborator.login.trim().length > 0)
                .map((collaborator) => ({
                login: collaborator.login,
                name: collaborator.name,
                htmlUrl: collaborator.html_url,
                roleName: collaborator.role_name,
                permissions: collaborator.permissions,
            }));
        },
    });
    const githubTokenPermissionClient = (connector, token) => ({
        async listRepositories(owner, opts) {
            return githubTokenValidationClient(connector, token).listRepositories(owner, opts);
        },
        async listCollaborators(repo) {
            const collaborators = await githubTokenJson(connector, token, `/repos/${repo.split('/').map(encodeURIComponent).join('/')}/collaborators?affiliation=all&per_page=100`);
            return collaborators
                .filter((collaborator) => typeof collaborator.login === 'string' && collaborator.login.trim().length > 0)
                .map((collaborator) => ({
                login: collaborator.login,
                name: collaborator.name,
                htmlUrl: collaborator.html_url,
                roleName: collaborator.role_name,
                permissions: collaborator.permissions,
            }));
        },
    });
    const validateGithubConnector = async (connectorId) => {
        const connector = getConnector(workspaceRoot, connectorId);
        if (!connector)
            return { ok: false, checked: [], errors: ['Connector not found.'], connector: null };
        let result;
        if (connector.credential.mode === 'static') {
            const credential = githubStaticToken(connector);
            result = credential.token
                ? await validateGithubConnectorAccess(connector, githubTokenValidationClient(connector, credential.token))
                : { ok: false, checked: [], errors: [credential.error ?? 'Static GitHub connector credential is not available.'] };
        }
        else {
            result = await validateGithubConnectorAccess(connector, githubGhValidationClient());
        }
        const updated = updateConnector(workspaceRoot, connector.id, {
            status: result.ok ? 'active' : 'error',
            lastError: result.ok ? undefined : result.errors[0] ?? 'GitHub connector validation failed.',
        }) ?? connector;
        return { ...result, connector: updated };
    };
    const githubConnectorClient = () => ({
        async listRepositories(owner, opts) {
            const limit = Math.max(1, Math.min(1000, opts?.limit ?? 100));
            const listed = await ghJson(['repo', 'list', owner, '--limit', String(limit), '--json', 'nameWithOwner'], { timeout: 20_000, maxBuffer: 4_000_000 });
            if (listed.error)
                throw new Error(listed.error);
            return (listed.data ?? []).map((repo) => repo.nameWithOwner ?? '').filter(Boolean);
        },
        async listIssues(repo, opts) {
            const args = ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,url,updatedAt,labels,assignees'];
            if (opts?.since)
                args.push('--search', `updated:>=${opts.since}`);
            const issues = await ghJson(args, { timeout: 20_000, maxBuffer: 6_000_000 });
            if (issues.error)
                throw new Error(issues.error);
            return (issues.data ?? []);
        },
        async listPullRequests(repo, opts) {
            const args = ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,url,updatedAt,author'];
            if (opts?.since)
                args.push('--search', `updated:>=${opts.since}`);
            const pulls = await ghJson(args, { timeout: 20_000, maxBuffer: 6_000_000 });
            if (pulls.error)
                throw new Error(pulls.error);
            return (pulls.data ?? []);
        },
        async listFiles(repo) {
            const tree = await ghJson(['api', `repos/${repo}/git/trees/HEAD?recursive=1`], { timeout: 20_000, maxBuffer: 10_000_000 });
            if (tree.error)
                throw new Error(tree.error);
            const blobs = (tree.data?.tree ?? []).filter((entry) => entry.type === 'blob' && entry.path).slice(0, 100);
            const files = [];
            for (const blob of blobs) {
                const pathName = blob.path ?? '';
                const content = await ghJson(['api', `repos/${repo}/contents/${pathName.split('/').map(encodeURIComponent).join('/')}`], { timeout: 10_000, maxBuffer: 2_000_000 });
                const text = content.data?.encoding === 'base64' && content.data.content
                    ? Buffer.from(content.data.content.replace(/\s+/g, ''), 'base64').toString('utf8')
                    : '';
                files.push({ path: pathName, text: text.slice(0, 100_000), sha: blob.sha, size: blob.size, url: content.data?.html_url ?? blob.url });
            }
            return files;
        },
    });
    const indexConnectorMemory = async (connectorId) => {
        const connector = getConnector(workspaceRoot, connectorId);
        if (!connector)
            return { ok: false, records: 0, evidence: 0, operations: 0, error: 'Connector not found.' };
        const bundle = exportConnectorDocumentsForMemory(workspaceRoot, { connectorId });
        if (bundle.recordCount === 0)
            return { ok: true, records: 0, evidence: 0, operations: 0, result: { importedMemories: 0, importedEvidence: 0, importedOperations: 0 } };
        try {
            const res = await mcpClient.callTool('memory_import', { data: bundle.data });
            if (res?.isError) {
                const text = typeof res.content?.[0]?.text === 'string' ? res.content[0].text : 'memory_import failed.';
                return { ok: false, records: bundle.recordCount, evidence: bundle.evidenceCount, operations: bundle.operationCount, error: text };
            }
            const text = typeof res?.content?.[0]?.text === 'string' ? res.content[0].text : '';
            const parsed = text.trim() ? JSON.parse(text) : {};
            return { ok: true, records: bundle.recordCount, evidence: bundle.evidenceCount, operations: bundle.operationCount, result: parsed };
        }
        catch (err) {
            return { ok: false, records: bundle.recordCount, evidence: bundle.evidenceCount, operations: bundle.operationCount, error: err instanceof Error ? err.message : String(err) };
        }
    };
    const runConnector = async (connectorId) => {
        const connector = getConnector(workspaceRoot, connectorId);
        if (!connector)
            return { ok: false, error: 'Connector not found.' };
        if (connector.source !== 'github')
            return { ok: false, error: `Connector runtime is not implemented for ${connector.source}.` };
        const startedAt = new Date().toISOString();
        const running = recordConnectorRun(workspaceRoot, {
            connectorId: connector.id,
            flow: 'checkpoint',
            status: 'running',
            startedAt,
            checkpointBefore: connector.checkpoint,
        });
        try {
            const result = await runGithubConnectorCheckpoint(connector, githubConnectorClient());
            const persisted = upsertConnectorDocuments(workspaceRoot, result.documents);
            const run = finishConnectorRun(workspaceRoot, connector.id, running.id, {
                status: result.failures.length ? 'failed' : 'succeeded',
                documentsSeen: result.documents.length,
                documentsIndexed: persisted.length,
                failures: result.failures.length,
                error: result.failures[0],
                checkpointAfter: result.checkpoint,
            }) ?? running;
            const memory = await indexConnectorMemory(connector.id);
            return {
                ok: result.failures.length === 0,
                run,
                connector: getConnector(workspaceRoot, connector.id) ?? null,
                documents: persisted.slice(0, 20),
                memory,
                errors: result.failures,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const run = finishConnectorRun(workspaceRoot, connector.id, running.id, {
                status: 'failed',
                error: msg,
            }) ?? running;
            return { ok: false, run, connector: getConnector(workspaceRoot, connector.id) ?? null, error: msg, errors: [msg] };
        }
    };
    const connectorRunsInFlight = new Set();
    const connectorPollMinutes = (connector) => {
        const raw = connector.config?.pollMinutes;
        const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
        return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 0;
    };
    const connectorDueForScheduledRun = (connector, now) => {
        if (connector.status !== 'active')
            return false;
        if (!connector.flows.includes('checkpoint'))
            return false;
        if (connectorRunsInFlight.has(connector.id))
            return false;
        const pollMinutes = connectorPollMinutes(connector);
        if (pollMinutes <= 0)
            return false;
        const lastRunMs = connector.lastRunAt ? Date.parse(connector.lastRunAt) : 0;
        return !Number.isFinite(lastRunMs) || lastRunMs <= 0 || now - lastRunMs >= pollMinutes * 60_000;
    };
    const tickConnectorScheduler = () => {
        const now = Date.now();
        for (const connector of listConnectors(workspaceRoot, { status: 'active' })) {
            if (!connectorDueForScheduledRun(connector, now))
                continue;
            connectorRunsInFlight.add(connector.id);
            void runConnector(connector.id)
                .catch(() => undefined)
                .finally(() => connectorRunsInFlight.delete(connector.id));
        }
    };
    const connectorSchedulerTimer = setInterval(tickConnectorScheduler, 60_000);
    connectorSchedulerTimer.unref?.();
    const connectorSchedulerBootTimer = setTimeout(tickConnectorScheduler, 10_000);
    connectorSchedulerBootTimer.unref?.();
    const syncConnectorPermissions = async (connectorId) => {
        const connector = getConnector(workspaceRoot, connectorId);
        if (!connector)
            return { ok: false, error: 'Connector not found.' };
        if (connector.source !== 'github')
            return { ok: false, error: `Permission sync is not implemented for ${connector.source}.` };
        const startedAt = new Date().toISOString();
        try {
            const credential = connector.credential.mode === 'static' ? githubStaticToken(connector) : {};
            if (connector.credential.mode === 'static' && !credential.token)
                throw new Error(credential.error ?? 'Static GitHub connector credential is not available.');
            const client = credential.token ? githubTokenPermissionClient(connector, credential.token) : githubGhPermissionClient();
            const result = await runGithubConnectorPermissionSync(connector, client);
            const persisted = upsertConnectorPermissions(workspaceRoot, result.permissions);
            const run = recordConnectorRun(workspaceRoot, {
                connectorId: connector.id,
                flow: 'permission-sync',
                status: result.failures.length ? 'failed' : 'succeeded',
                startedAt,
                permissionsSeen: result.permissions.length,
                permissionsIndexed: persisted.length,
                failures: result.failures.length,
                error: result.failures[0],
                checkpointBefore: connector.checkpoint,
                checkpointAfter: result.checkpoint,
            });
            return {
                ok: result.failures.length === 0,
                run,
                connector: getConnector(workspaceRoot, connector.id) ?? null,
                permissions: persisted.slice(0, 20),
                errors: result.failures,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const run = recordConnectorRun(workspaceRoot, {
                connectorId: connector.id,
                flow: 'permission-sync',
                status: 'failed',
                startedAt,
                error: msg,
                checkpointBefore: connector.checkpoint,
            });
            return { ok: false, run, connector: getConnector(workspaceRoot, connector.id) ?? null, error: msg, errors: [msg] };
        }
    };
    const createTrackDraftPr = async (idOrKey) => {
        const item = getWorkItem(workspaceRoot, idOrKey);
        if (!item)
            return { ok: false, items: listWorkItems(workspaceRoot), error: `Unknown work item "${idOrKey}".` };
        const branch = await currentGitBranch();
        if (!branch)
            return { ok: false, items: listWorkItems(workspaceRoot), itemKey: item.key, error: 'No current Git branch.' };
        const linkedBranch = item.codeLinks.find((link) => link.kind === 'branch')?.ref;
        if (linkedBranch && linkedBranch !== branch) {
            return { ok: false, items: listWorkItems(workspaceRoot), branch, itemKey: item.key, error: `Switch to ${linkedBranch} before creating a PR for ${item.key}.` };
        }
        const dirty = (await git(['status', '--porcelain', '--', '.'], workspaceRoot)).trim();
        if (dirty)
            return { ok: false, items: listWorkItems(workspaceRoot), branch, itemKey: item.key, error: 'Commit or stash local changes before creating a PR.' };
        const issue = getGithubLinks(workspaceRoot)[item.id];
        const body = [
            `Track item: ${item.key}`,
            item.description?.trim(),
            issue?.number ? `Fixes #${issue.number}` : undefined,
            `Branch: ${branch}`,
        ].filter(Boolean).join('\n\n');
        const created = await ghText(['pr', 'create', '--draft', '--title', `${item.key}: ${item.title}`, '--body', body], { timeout: 20_000, maxBuffer: 500_000 });
        if (!created.ok)
            return { ok: false, items: listWorkItems(workspaceRoot), branch, itemKey: item.key, error: created.error ?? 'GitHub CLI could not create the PR.' };
        const url = created.stdout.split(/\s+/).find((part) => /^https?:\/\//.test(part)) ?? created.stdout.trim();
        if (url)
            linkWorkItem(workspaceRoot, item.id, { codeLinks: [{ kind: 'pull-request', ref: url, label: 'GitHub PR' }] });
        prCache = null;
        const status = await readTrackPrStatus();
        return { ok: true, url, pr: status.pr, branch, itemKey: item.key, items: listWorkItems(workspaceRoot) };
    };
    const importTrackIssuesFromGh = async (args) => {
        const project = ensureProject(workspaceRoot);
        const limit = Math.min(Math.max(1, Number(args.limit) || 30), 100);
        const state = args.state === 'all' || args.state === 'closed' ? String(args.state) : 'open';
        const dryRun = args.dryRun === true;
        const ghIssues = await ghJson(['issue', 'list', '--state', state, '--limit', String(limit), '--json', 'number,title,body,state,url,labels,assignees'], { timeout: 12_000, maxBuffer: 4_000_000 });
        if (ghIssues.error)
            return { direction: 'import', dryRun, imported: [], errors: [ghIssues.error], items: listWorkItems(workspaceRoot) };
        const imported = [];
        const errors = [];
        const links = getGithubLinks(workspaceRoot);
        const byNumber = new Map();
        for (const [wid, link] of Object.entries(links))
            byNumber.set(link.number, wid);
        for (const raw of ghIssues.data ?? []) {
            const issue = {
                ...raw,
                state: String(raw.state ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open',
                html_url: raw.html_url ?? raw.url,
            };
            const mapped = issueToWorkItem(issue, project);
            const existingByKey = mapped.key ? getWorkItem(workspaceRoot, mapped.key) : undefined;
            const existingById = byNumber.get(issue.number);
            const existing = existingByKey ?? (existingById ? getWorkItem(workspaceRoot, existingById) : undefined);
            imported.push({ issueNumber: issue.number, title: issue.title, action: existing ? 'update' : 'create', key: existing?.key ?? mapped.key });
            if (dryRun)
                continue;
            try {
                if (existing) {
                    updateWorkItem(workspaceRoot, existing.id, mapped.patch, 'agent');
                    setGithubLink(workspaceRoot, existing.id, { number: issue.number, url: issue.html_url ?? '' });
                }
                else {
                    const created = createWorkItem(workspaceRoot, { ...mapped.input, actor: 'agent' });
                    setGithubLink(workspaceRoot, created.id, { number: issue.number, url: issue.html_url ?? '' });
                }
            }
            catch (error) {
                errors.push(`#${issue.number}: ${error.message}`);
            }
        }
        return { direction: 'import', dryRun, imported, errors, items: listWorkItems(workspaceRoot) };
    };
    const mergeCurrentTrackPr = async () => {
        const status = await readTrackPrStatus();
        if (!status.pr?.number)
            return { ok: false, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot), error: status.error ?? 'No pull request for the current branch.' };
        if (status.pr.isDraft)
            return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot), error: 'Mark the pull request ready before merging.' };
        const merged = await ghText(['pr', 'merge', String(status.pr.number), '--squash', '--delete-branch'], { timeout: 20_000, maxBuffer: 500_000 });
        if (!merged.ok)
            return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot), error: merged.error ?? 'GitHub CLI could not merge the PR.' };
        if (status.itemKey) {
            const project = getProject(workspaceRoot) ?? ensureProject(workspaceRoot);
            const done = project.workflowStates.find((state) => state.category === 'done');
            if (done)
                transitionWorkItem(workspaceRoot, status.itemKey, done.id, 'user');
        }
        prCache = null;
        return { ok: true, pr: status.pr, branch: status.branch, itemKey: status.itemKey, items: listWorkItems(workspaceRoot) };
    };
    const submitTrackPrReview = async (args) => {
        const status = await readTrackPrStatus();
        if (!status.pr?.number)
            return { ok: false, branch: status.branch, itemKey: status.itemKey, error: status.error ?? 'No pull request for the current branch.' };
        const decision = args.decision === 'approve' || args.decision === 'request-changes' ? args.decision : 'comment';
        const body = String(args.body ?? '').trim();
        if (decision === 'comment' && !body)
            return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, error: 'Review comment cannot be empty.' };
        const flag = decision === 'approve' ? '--approve' : decision === 'request-changes' ? '--request-changes' : '--comment';
        const cmd = ['pr', 'review', String(status.pr.number), flag];
        if (body)
            cmd.push('--body', body);
        const reviewed = await ghText(cmd, { timeout: 15_000, maxBuffer: 500_000 });
        if (!reviewed.ok)
            return { ok: false, pr: status.pr, branch: status.branch, itemKey: status.itemKey, error: reviewed.error ?? 'GitHub CLI could not submit the review.' };
        return { ok: true, pr: status.pr, branch: status.branch, itemKey: status.itemKey };
    };
    const fixCurrentTrackPrChecks = async () => {
        const status = await readTrackPrStatus();
        if (!status.pr?.number)
            return { ok: false, branch: status.branch, itemKey: status.itemKey, error: status.error ?? 'No pull request for the current branch.' };
        const sessionKey = activeAgent.sessionKey;
        const task = createBackgroundTask(workspaceRoot, {
            kind: 'verification',
            title: `Fix failing checks — PR #${status.pr.number}`,
            sessionKey,
            status: 'running',
        });
        const fixerKey = `fix-ci:${task.id}`;
        const created = updateBackgroundTask(workspaceRoot, task.id, { transcript: { kind: 'task', id: task.id, parentSessionKey: fixerKey } }) ?? task;
        emitTaskEvent('created', created);
        void (async () => {
            try {
                taskProgress(task.id, 'reading-ci', `PR #${status.pr?.number ?? ''}`);
                const checks = await ghJson(['pr', 'checks', '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'], { timeout: 10_000, maxBuffer: 2_000_000, allowNonZeroJson: true });
                const runs = await ghJson(['run', 'list', '--limit', '10', '--json', 'databaseId,name,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url'], { timeout: 10_000, maxBuffer: 4_000_000 });
                const failedChecks = (checks.data ?? []).filter((c) => {
                    const bucket = String(c.bucket ?? c.state ?? '').toLowerCase();
                    return bucket === 'fail' || bucket === 'failed' || bucket === 'failure' || bucket === 'cancel' || bucket === 'cancelled';
                });
                const failedRun = (runs.data ?? []).find((r) => String(r.conclusion ?? '').toLowerCase() === 'failure');
                let failedLog = '';
                if (failedRun?.databaseId) {
                    const log = await ghText(['run', 'view', String(failedRun.databaseId), '--log-failed'], { timeout: 20_000, maxBuffer: 8_000_000 });
                    failedLog = (log.stdout || log.error || '').slice(-40_000);
                }
                const prompt = [
                    'The current branch has a GitHub pull request with failing CI. Fix the failing checks locally.',
                    'Do not commit, push, merge, or create a pull request. Make the smallest code changes needed, then stop.',
                    `PR: #${status.pr?.number} ${status.pr?.title ?? ''}`,
                    `Branch: ${status.branch ?? status.pr?.headRefName ?? 'current branch'}`,
                    failedChecks.length ? `Failing checks:\n${failedChecks.map((c) => `- ${c.workflow ? `${c.workflow}: ` : ''}${c.name ?? 'check'} (${c.bucket ?? c.state ?? 'failed'})${c.link ? ` ${c.link}` : ''}`).join('\n')}` : 'Failing checks: not available from gh pr checks.',
                    failedRun ? `Latest failed run: ${failedRun.workflowName ?? failedRun.name ?? 'run'} ${failedRun.databaseId ?? ''} ${failedRun.url ?? ''}` : 'Latest failed run: not available from gh run list.',
                    failedLog ? `Failed log excerpt:\n${failedLog}` : '',
                ].filter(Boolean).join('\n\n');
                taskProgress(task.id, 'fixing-ci', failedChecks[0]?.name ?? failedRun?.workflowName ?? 'failed checks');
                const fixer = spawnTaskAgent(fixerKey, 'write');
                const noop = () => { };
                const cb = {
                    onStatusUpdate: (text) => { if (text)
                        taskProgress(task.id, 'working', text.slice(0, 80)); },
                    onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop,
                    onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop,
                };
                await fixer.runTurn(prompt, cb);
                const changed = (await git(['status', '--short', '--', '.'], workspaceRoot)).split('\n').filter(Boolean);
                const done = updateBackgroundTask(workspaceRoot, task.id, { status: 'completed', result: { pr: status.pr?.number, changedFiles: changed.length } });
                if (done)
                    emitTaskEvent('completed', done);
            }
            catch (err) {
                const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: `Fix CI task failed: ${err instanceof Error ? err.message : err}` });
                if (failed)
                    emitTaskEvent('failed', failed);
            }
        })();
        return { ok: true, task: created, pr: status.pr, branch: status.branch, itemKey: status.itemKey };
    };
    const core = createHostCore({
        agent,
        spawnAgent,
        onActiveAgentChange: (a) => { activeAgent = a; },
        send: send,
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
        queries: {
            // ── Mobile-app query surface (brainrouter-mobile / RemoteTransport) ──
            // This host serves ONE workspace (the paired one), so the workspace-mgmt
            // methods return that single-workspace reality (no multi-workspace recents
            // to track). The three TODO entries degrade gracefully until their shapes
            // are wired against real output (see docs/host-server.md).
            'workspace-recents': () => ({ current: workspaceRoot, recents: [workspaceRoot] }),
            'open-workspace': () => ({ opened: true }),
            'is-workspace-trusted': () => ({ trusted: true }),
            'trust-workspace': () => ({ trusted: true }),
            'untrust-workspace': () => ({ trusted: false }),
            'trusted-workspaces': () => ({ trusted: [workspaceRoot] }),
            'mark-activity': () => ({ ok: true }),
            'reorder-workspace': () => ({ recents: [workspaceRoot] }),
            'global-dashboard': () => ({ workspaces: [{ workspaceRoot, tasks: [], reviewGate: null }] }),
            'worktrees': async () => ({ porcelain: await git(['worktree', 'list', '--porcelain'], workspaceRoot), current: workspaceRoot }),
            'search': (a) => {
                // Single-session search over the recent transcript window (mirrors the
                // desktop 'search-transcript'), mapped to the mobile hit shape.
                const q = typeof a.q === 'string' ? a.q : '';
                return searchTranscript(readTranscriptTail(workspaceRoot, activeAgent.sessionKey, 5000), q, { limit: 50 })
                    .map((m) => ({ sessionKey: activeAgent.sessionKey, title: m.role ?? 'match', snippet: m.snippet ?? '' }));
            },
            'ci-checks': async () => new Promise((resolve) => {
                // `gh pr checks` already emits the CheckRow shape the mobile ciFormat expects.
                execFile('gh', ['pr', 'checks', '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'], { cwd: workspaceRoot, timeout: 8_000, maxBuffer: 2_000_000 }, (_err, stdout) => {
                    try {
                        resolve(JSON.parse(stdout));
                    }
                    catch {
                        resolve([]);
                    }
                });
            }),
            'term-run': async (a) => new Promise((resolve) => {
                // One-shot command (the mobile Terminal's model), via the same shell exec
                // the desktop term-* sessions use. Combined stdout+stderr.
                const command = typeof a.cmd === 'string' ? a.cmd : '';
                if (!command) {
                    resolve({ output: '' });
                    return;
                }
                exec(command, { cwd: workspaceRoot, timeout: 15_000, maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
                    resolve({ output: `${stdout ?? ''}${stderr ?? ''}${err && !stdout && !stderr ? err.message : ''}` });
                });
            }),
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
                if (!root || !fs.existsSync(root))
                    return { rows: [], error: 'Workspace is not available.' };
                try {
                    const rows = sessionRows(root, limit);
                    return { rows, truncated: rows.length >= limit };
                }
                catch (err) {
                    return { rows: [], error: err instanceof Error ? err.message : String(err) };
                }
            },
            // CONNECTORS — Onyx-like connector lifecycle foundation. These wrappers
            // expose the core catalog/store to the renderer without making Track Sync
            // pretend to be the general connector abstraction.
            'connectors-catalog': () => ({ catalog: listConnectorCatalog() }),
            'connectors-list': (args) => {
                const source = typeof args.source === 'string' ? args.source : undefined;
                const status = typeof args.status === 'string' ? args.status : undefined;
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
                kind: typeof args.kind === 'string' ? args.kind : undefined,
                query: typeof args.query === 'string' ? args.query : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
            }),
            'connector-slim-documents': (args) => retrieveConnectorSlimDocuments(workspaceRoot, {
                connectorId: typeof args.connectorId === 'string' ? args.connectorId : undefined,
                repository: typeof args.repository === 'string' ? args.repository : undefined,
                kind: typeof args.kind === 'string' ? args.kind : undefined,
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
                        source: args.source,
                        name: typeof args.name === 'string' ? args.name : '',
                        description: typeof args.description === 'string' ? args.description : undefined,
                        config: args.config && typeof args.config === 'object' && !Array.isArray(args.config) ? args.config : undefined,
                        credential: args.credential && typeof args.credential === 'object' && !Array.isArray(args.credential) ? args.credential : undefined,
                        flows: Array.isArray(args.flows) ? args.flows : undefined,
                    });
                    return { ok: true, connector };
                }
                catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
            },
            'action:connector-update': (args) => {
                try {
                    const id = typeof args.id === 'string' ? args.id : '';
                    const patch = args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch : {};
                    const connector = id ? updateConnector(workspaceRoot, id, patch) : undefined;
                    return connector ? { ok: true, connector } : { ok: false, error: 'Connector not found.' };
                }
                catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
            },
            'action:connector-delete': (args) => {
                const id = typeof args.id === 'string' ? args.id : '';
                return { ok: id ? deleteConnector(workspaceRoot, id) : false };
            },
            'action:connector-export-definitions': (args) => {
                try {
                    const connectorIds = Array.isArray(args.connectorIds) ? args.connectorIds.filter((id) => typeof id === 'string') : undefined;
                    const bundle = exportConnectorDefinitions(workspaceRoot, { connectorIds });
                    return { ok: true, bundle, json: JSON.stringify(bundle, null, 2) };
                }
                catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
            },
            'action:connector-import-definitions': (args) => {
                try {
                    const input = typeof args.json === 'string' ? args.json : args.bundle;
                    if (!input)
                        return { ok: false, error: 'Connector definition JSON is required.' };
                    const connectors = importConnectorDefinitions(workspaceRoot, input);
                    return { ok: true, connectors };
                }
                catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
            },
            'action:connector-record-run': (args) => {
                try {
                    const run = recordConnectorRun(workspaceRoot, {
                        connectorId: typeof args.connectorId === 'string' ? args.connectorId : '',
                        flow: args.flow,
                        status: args.status,
                        documentsSeen: typeof args.documentsSeen === 'number' ? args.documentsSeen : undefined,
                        documentsIndexed: typeof args.documentsIndexed === 'number' ? args.documentsIndexed : undefined,
                        permissionsSeen: typeof args.permissionsSeen === 'number' ? args.permissionsSeen : undefined,
                        permissionsIndexed: typeof args.permissionsIndexed === 'number' ? args.permissionsIndexed : undefined,
                        failures: typeof args.failures === 'number' ? args.failures : undefined,
                        error: typeof args.error === 'string' ? args.error : undefined,
                        checkpointBefore: args.checkpointBefore && typeof args.checkpointBefore === 'object' && !Array.isArray(args.checkpointBefore) ? args.checkpointBefore : undefined,
                        checkpointAfter: args.checkpointAfter && typeof args.checkpointAfter === 'object' && !Array.isArray(args.checkpointAfter) ? args.checkpointAfter : undefined,
                    });
                    return { ok: true, run, connector: getConnector(workspaceRoot, run.connectorId) ?? null };
                }
                catch (err) {
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
                if (prCache && now - prCache.at < 60_000)
                    return { pr: prCache.pr };
                const view = await ghJson(['pr', 'view', '--json', 'number,state,title'], { timeout: 4_000, maxBuffer: 200_000 });
                const j = view.data;
                const pr = typeof j?.number === 'number' ? { number: j.number, state: String(j.state ?? 'OPEN'), title: j.title } : null;
                prCache = { at: now, pr };
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
                const list = await ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,state,url,headRefName,baseRefName,author,isDraft,body,updatedAt'], { timeout: 8_000, maxBuffer: 4_000_000, allowNonZeroJson: true });
                return list.error ? { prs: [], error: list.error } : { prs: list.data ?? [] };
            },
            // §session-pr — a compact ALL-STATES PR list (open + merged + closed) keyed
            // later by headRefName so the sidebar can show each session's PR status.
            // Cached ~60s; degrades to [] when gh is missing/unauthed.
            'git-pr-status-map': async () => {
                const now = Date.now();
                if (prStatusMapCache && now - prStatusMapCache.at < 60_000)
                    return { prs: prStatusMapCache.prs };
                const list = await ghJson(['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,state,headRefName,isDraft,mergeable,url'], { timeout: 12_000, maxBuffer: 4_000_000, allowNonZeroJson: true });
                const prs = list.data ?? [];
                prStatusMapCache = { at: now, prs };
                return list.error ? { prs, error: list.error } : { prs };
            },
            'git-pr-detail': async () => {
                const view = await ghJson(['pr', 'view', '--json', 'number,state,title,url,headRefName,baseRefName,author,isDraft,mergeable,statusCheckRollup'], { timeout: 8_000, maxBuffer: 2_000_000 });
                return view.error ? { pr: null, error: view.error } : { pr: view.data ?? null };
            },
            'git-pr-checks': async () => {
                // `gh pr checks` exits non-zero when checks are pending/failing but still
                // prints JSON — capture stdout regardless of the exit code.
                const checks = await ghJson(['pr', 'checks', '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'], { timeout: 8_000, maxBuffer: 2_000_000, allowNonZeroJson: true });
                return checks.error ? { checks: [], error: checks.error } : { checks: checks.data ?? [] };
            },
            'git-actions-runs': async (args) => {
                const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50);
                const runs = await ghJson(['run', 'list', '--limit', String(limit), '--json', 'databaseId,name,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url'], { timeout: 9_000, maxBuffer: 4_000_000 });
                return runs.error ? { runs: [], error: runs.error } : { runs: runs.data ?? [] };
            },
            'git-actions-run-detail': async (args) => {
                const id = String(args.id ?? '').replace(/[^0-9]/g, '');
                if (!id)
                    return { run: null, error: 'No run id.' };
                const run = await ghJson(['run', 'view', id, '--json', 'databaseId,name,displayTitle,status,conclusion,jobs,workflowName,headBranch,url,createdAt'], { timeout: 9_000, maxBuffer: 4_000_000 });
                return run.error ? { run: null, error: run.error } : { run: run.data ?? null };
            },
            'git-actions-run-log': async (args) => {
                const id = String(args.id ?? '').replace(/[^0-9]/g, '');
                if (!id)
                    return { log: '', error: 'No run id.' };
                const flag = args.failedOnly ? '--log-failed' : '--log';
                const log = await ghText(['run', 'view', id, flag], { timeout: 15_000, maxBuffer: 8_000_000 });
                return { log: log.stdout.slice(0, 200_000), error: log.ok ? undefined : (log.error ?? 'gh run log failed') };
            },
            'action:git-actions-rerun-failed': async (args) => {
                const id = String(args.id ?? '').replace(/[^0-9]/g, '');
                if (!id)
                    return { ok: false, error: 'No run id.' };
                const rerun = await ghText(['run', 'rerun', id, '--failed'], { timeout: 10_000, maxBuffer: 200_000 });
                return rerun.ok ? { ok: true, id } : { ok: false, error: rerun.error ?? 'Rerun failed.' };
            },
            'recap': (args) => {
                const key = typeof args.sessionKey === 'string' ? args.sessionKey : activeAgent.sessionKey;
                // OOM-safe: recap summarizes recent state — a bounded tail is enough.
                return buildRecap({ entries: readTranscriptTail(workspaceRoot, key, 2000), sessionKey: key });
            },
            // DESK-5w — running background tasks for the active workspace. Rows keep
            // parentSessionKey for transcript lookup, but the renderer shows them in
            // Background tasks rather than as chat-list children.
            'fleet': () => {
                const tasks = collectRunningTasks(workspaceRoot);
                const sessions = listSessions(workspaceRoot);
                const workers = listWorkers(workspaceRoot);
                const live = tasks.map((t) => {
                    let parentSessionKey = null;
                    if (t.kind === 'agent')
                        parentSessionKey = sessions.find((s) => s.id === t.id)?.parentSessionKey ?? null;
                    else if (t.kind === 'worker')
                        parentSessionKey = workers.find((w) => w.id === t.id)?.parentSessionKey ?? null;
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
                const status = a.status === 'all' ? 'all' : 'active';
                const sessionKey = scope === 'session' ? (typeof a.sessionKey === 'string' ? a.sessionKey : activeAgent.sessionKey) : undefined;
                const rows = listBackgroundTasks(workspaceRoot, { sessionKey, status });
                return rows.map((t) => ({ ...t, phase: currentPhase(t), workspaceRoot }));
            },
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
                const sessionKey = activeAgent.sessionKey;
                const name = typeof a.name === 'string' ? a.name : '';
                const startedAt = Date.now();
                try {
                    let source;
                    if (typeof a.path === 'string' && a.path)
                        source = { kind: 'path', path: a.path };
                    else if (typeof a.dataBase64 === 'string')
                        source = { kind: 'bytes', name: name || 'file', data: Buffer.from(a.dataBase64, 'base64') };
                    else
                        throw new Error('attachment-ingest needs a path or dataBase64.');
                    const record = await ingestAttachment({
                        workspaceRoot, sessionKey,
                        requirementId: typeof a.requirementId === 'string' ? a.requirementId : undefined,
                        source,
                    });
                    try {
                        const memoryId = (await emitAgentEvent({ mcpClient, sessionKey }, {
                            kind: 'agent_output',
                            summary: `Attachment ${record.id}: ${record.name} [${record.kind}] ${record.mimeType}`,
                            payload: { attachmentId: record.id, name: record.name, kind: record.kind, mimeType: record.mimeType, byteSize: record.byteSize, pageCount: record.pageCount, context: attachmentContextMarkdown(record, { maxChars: 4_000 }) },
                        })) ?? undefined;
                        if (memoryId)
                            linkAttachmentMemory(workspaceRoot, record.id, memoryId);
                    }
                    catch { /* advisory */ }
                    recordTelemetry({ name: TELEMETRY_EVENTS.attachment_ingested, workspaceRoot, sessionKey, ok: true, durationMs: Date.now() - startedAt, props: { kind: record.kind, bytes: record.byteSize } });
                    return { ok: true, attachment: record, contextMarkdown: attachmentContextMarkdown(record, { maxChars: 3_000 }) };
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    recordTelemetry({ name: TELEMETRY_EVENTS.attachment_ingested, workspaceRoot, sessionKey, ok: false, durationMs: Date.now() - startedAt, error: msg });
                    return { ok: false, error: msg };
                }
            },
            'attachment-list': (a) => {
                const sessionKey = a.scope === 'workspace' ? undefined : (typeof a.sessionKey === 'string' ? a.sessionKey : activeAgent.sessionKey);
                return listAttachments(workspaceRoot, { sessionKey });
            },
            'attachment-read': (a) => {
                const rec = getAttachment(workspaceRoot, typeof a.id === 'string' ? a.id : '');
                if (!rec)
                    return null;
                // For images, hand back a (size-capped) data URI so the panel can preview
                // without a second file-protocol round-trip; text/pdf use extractedText.
                let dataUri;
                if (rec.kind === 'image' && rec.byteSize < 5_000_000) {
                    try {
                        dataUri = `data:${rec.mimeType};base64,${fs.readFileSync(rec.storedPath).toString('base64')}`;
                    }
                    catch { /* unreadable blob */ }
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
                return { sessionKey: activeAgent.sessionKey, model: activeAgent.getModel?.() ?? current.model, workspaceRoot, username: os.userInfo().username };
            },
            // DESK-4d — the home/greeting view: real numbers from the workspace's
            // persisted transcripts (sessions, messages, active days, streaks, and
            // a per-day activity map for the heatmap).
            'home-stats': () => {
                const transcripts = listTranscripts(workspaceRoot, { limit: 200 });
                let turns = 0;
                const perDay = new Map();
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
                const dayKey = (offset) => {
                    const d = new Date(today);
                    d.setDate(d.getDate() - offset);
                    return d.toISOString().slice(0, 10);
                };
                let current = 0;
                for (let i = 0; perDay.has(dayKey(i)); i++)
                    current++;
                let longest = 0, run = 0;
                for (let i = 0; i < 365; i++) {
                    if (perDay.has(dayKey(i))) {
                        run++;
                        longest = Math.max(longest, run);
                    }
                    else
                        run = 0;
                }
                return {
                    sessions: transcripts.length,
                    turns,
                    activeDays: perDay.size,
                    currentStreak: current,
                    longestStreak: longest,
                    model: activeAgent.getModel?.() ?? llm.model,
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
                if (!text.trim())
                    return { text: '', error: 'No text selected.' };
                const llm = llmForSession(activeAgent.sessionKey);
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
                    raw = resp?.content ?? '';
                }
                catch (e) {
                    return { text: '', error: `Model call failed: ${e instanceof Error ? e.message : String(e)}` };
                }
                let revised = raw.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
                if (action === 'continue')
                    revised = text + (/\s$/.test(text) ? '' : ' ') + revised;
                return { text: revised };
            },
            // §2 W4 — Write-mode ghost-text inline completion. A short, fast, read-only
            // continuation of the text before the cursor; the editor renders it as a
            // ghost suggestion (Tab accepts). Empty answer ⇒ no suggestion.
            'write-ghost-complete': async (args) => {
                const prefix = typeof args.prefix === 'string' ? args.prefix : '';
                if (prefix.trim().length < 3)
                    return { text: '' };
                const llm = llmForSession(activeAgent.sessionKey);
                if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai'))
                    return { text: '' };
                const system = 'You are an inline writing autocomplete. Continue the user\'s text by a few words up to one sentence. Return ONLY the continuation that comes immediately AFTER their text — never repeat their text, no quotes, no preamble. If nothing natural follows, return an empty string.';
                let raw = '';
                try {
                    const resp = await callOpenAI(llm, [{ role: 'system', content: system }, { role: 'user', content: prefix.slice(-2000) }], [], { effort: 'low' });
                    raw = resp?.content ?? '';
                }
                catch {
                    return { text: '' };
                }
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
                if (!question.trim())
                    return { text: '', error: 'Ask a question.' };
                const llm = llmForSession(writeThreadKey(workspaceRoot));
                if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
                    return { text: '', error: 'No model configured — set a provider/model (and API key) in Settings.' };
                }
                let grounding = '';
                try {
                    const listed = await listWorkspaceFilesCached({ limit: 3000 });
                    const mdPaths = (listed.files ?? [])
                        .map((f) => (typeof f === 'string' ? f : f.path))
                        .filter((p) => !!p && /\.(md|markdown|mdx|txt)$/i.test(p))
                        .slice(0, 60);
                    const docs = mdPaths
                        .map((p) => { const r = readWorkspaceEntry(workspaceRoot, p); return { path: p, content: typeof r?.content === 'string' ? r.content : '' }; })
                        .filter((d) => d.content.trim());
                    const current = typeof args.currentPath === 'string' ? args.currentPath : undefined;
                    grounding = buildGroundingBlock(pickLocalGrounding(question, docs, current, 3));
                }
                catch { /* grounding is best-effort */ }
                const system = 'You are a writing assistant for this workspace. Be concise and practical.' +
                    (grounding ? ' Ground your answer in the provided workspace documents and cite the source path when you rely on one.' : '');
                const user = grounding ? `${grounding}\n\n---\nQuestion: ${question}` : question;
                try {
                    const resp = await callOpenAI(llm, [{ role: 'system', content: system }, { role: 'user', content: user }], [], { effort: 'low' });
                    return { text: (resp?.content ?? '').trim(), grounded: !!grounding };
                }
                catch (e) {
                    return { text: '', error: `Model call failed: ${e instanceof Error ? e.message : String(e)}` };
                }
            },
            // §7 L4 — visual workflow canvas persistence (graphs under <stateDir>/workflows/).
            'workflow-list': () => listWorkflowGraphs(workspaceRoot),
            'workflow-save': (args) => saveWorkflowGraph(workspaceRoot, (args.graph ?? {})),
            'workflow-load': (args) => loadWorkflowGraph(workspaceRoot, typeof args.id === 'string' ? args.id : ''),
            'workflow-delete': (args) => ({ ok: deleteWorkflowGraph(workspaceRoot, typeof args.id === 'string' ? args.id : '') }),
            // §5.9 — customizable keyboard shortcuts: read/persist user overrides in
            // cli.shortcuts (action id → neutral combo). Both heads read the same file.
            'shortcuts-get': () => {
                const cli = loadConfig().cli;
                return { overrides: (cli?.shortcuts && typeof cli.shortcuts === 'object') ? cli.shortcuts : {} };
            },
            'shortcuts-save': (args) => {
                const raw = (args.overrides && typeof args.overrides === 'object') ? args.overrides : {};
                const clean = {};
                for (const [k, v] of Object.entries(raw))
                    if (typeof v === 'string' && v.trim())
                        clean[k] = v.trim();
                const fresh = loadConfig();
                fresh.cli = { ...(fresh.cli ?? {}), shortcuts: clean };
                saveConfig(fresh);
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
                        : (result?.content?.[0]?.text ?? JSON.stringify(result));
                    try {
                        const parsed = JSON.parse(text);
                        const records = Array.isArray(parsed)
                            ? parsed
                            : (parsed?.records
                                ?? parsed?.results
                                ?? parsed?.memories
                                ?? []);
                        return { records, raw: Array.isArray(records) && records.length ? '' : text };
                    }
                    catch {
                        return { records: [], raw: text };
                    }
                }
                catch (e) {
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
                };
                const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim();
                if (!branch)
                    return { ...base, branch: null, files: 0, insertions: 0, deletions: 0 };
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
                if (!file)
                    return { path: file, diff: '' };
                // DESK-6w (T9) — a directory has no single-file diff; return a typed
                // payload rather than letting `git diff --no-index` misbehave on a folder.
                if (isWorkspaceDirectory(workspaceRoot, file))
                    return { path: file, kind: 'directory', diff: '' };
                // HEAD diff covers staged + unstaged; untracked files get a synthetic add-diff
                // (git diff --no-index exits 1 but its stdout — captured by `git` — IS the diff).
                let diff = await git(['diff', 'HEAD', '--', file], workspaceRoot, { maxBuffer: 4_000_000 });
                if (!diff.trim())
                    diff = await git(['diff', '--no-index', '--', '/dev/null', file], workspaceRoot, { maxBuffer: 4_000_000 });
                return { path: file, kind: 'file', diff: diff.slice(0, 200_000) };
            },
            // End-of-turn changeset — per-file numstat for the files the agent edited
            // THIS turn (paths come from the renderer's turn tracking). Covers tracked
            // (staged+unstaged) churn plus untracked new files (synth add-diff), so the
            // transcript card can show "Edited N files +X −Y" with accurate per-file +/-.
            'turn-changeset': async (args) => {
                const paths = Array.isArray(args.paths)
                    ? args.paths.filter((p) => typeof p === 'string').slice(0, 200)
                    : [];
                if (!paths.length)
                    return { files: [], insertions: 0, deletions: 0 };
                const stat = new Map();
                const numstat = await git(['diff', 'HEAD', '--numstat', '--', ...paths], workspaceRoot, { maxBuffer: 4_000_000 }).catch(() => '');
                for (const line of numstat.split('\n').filter(Boolean)) {
                    const parts = line.split('\t');
                    if (parts.length < 3)
                        continue;
                    stat.set(parts.slice(2).join('\t'), {
                        added: parts[0] === '-' ? 0 : Number(parts[0]) || 0,
                        removed: parts[1] === '-' ? 0 : Number(parts[1]) || 0,
                    });
                }
                const statusByPath = new Map();
                const porcelain = await git(['status', '--porcelain', '--', ...paths], workspaceRoot).catch(() => '');
                for (const line of porcelain.split('\n').filter(Boolean))
                    statusByPath.set(line.slice(3).trim(), line.slice(0, 2).trim() || 'M');
                // Untracked new files have no HEAD numstat — count their lines via add-diff.
                for (const p of paths) {
                    if (stat.has(p))
                        continue;
                    if (statusByPath.get(p) === '??' || !statusByPath.has(p)) {
                        const add = await git(['diff', '--no-index', '--numstat', '--', '/dev/null', p], workspaceRoot).catch(() => '');
                        const first = add.split('\n').filter(Boolean)[0];
                        if (first) {
                            const parts = first.split('\t');
                            stat.set(p, { added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 });
                            if (!statusByPath.has(p))
                                statusByPath.set(p, 'A');
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
                if (!wtPath || !fs.existsSync(wtPath))
                    return { path: wtPath, diff: '', files: 0 };
                const diff = await git(['diff', 'HEAD'], wtPath, { maxBuffer: 4_000_000 });
                const stat = await git(['diff', 'HEAD', '--shortstat'], wtPath);
                return { path: wtPath, diff: diff.slice(0, 200_000), files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0) };
            },
            'worktree-create': async (args) => {
                const name = String(args.name ?? '').trim();
                const ref = String(args.ref ?? '').trim() || 'HEAD';
                if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..')
                    return { ok: false, error: 'Name must be letters, digits, dash, underscore or dot.' };
                const root = wsGit.gitRoot ?? workspaceRoot;
                const wtPath = path.join(root, '.worktrees', name);
                // execFile-based git() never invokes a shell, so name/ref aren't shell-expanded.
                const out = await git(['worktree', 'add', wtPath, ref], root);
                if (!fs.existsSync(wtPath))
                    return { ok: false, error: out.trim() || `Failed to create worktree "${name}".` };
                return { ok: true, path: wtPath };
            },
            'worktree-remove': async (args) => {
                const wtPath = String(args.path ?? '').trim();
                const root = wsGit.gitRoot ?? workspaceRoot;
                if (!wtPath)
                    return { ok: false, error: 'No worktree path.' };
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
                const input = {
                    title: String(a.title ?? 'Untitled'),
                    type: (typeof a.type === 'string' ? a.type : 'task'),
                    status: typeof a.status === 'string' ? a.status : undefined,
                    sessionKey: activeAgent.sessionKey,
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
                const patch = (a.patch && typeof a.patch === 'object' ? a.patch : {});
                updateWorkItem(workspaceRoot, String(a.idOrKey ?? ''), patch, 'user');
                return listWorkItems(workspaceRoot);
            },
            'track-comment': (a) => {
                addComment(workspaceRoot, String(a.idOrKey ?? ''), 'user', String(a.body ?? ''));
                return listWorkItems(workspaceRoot);
            },
            'track-link': (a) => {
                linkWorkItem(workspaceRoot, String(a.idOrKey ?? ''), {
                    codeLinks: Array.isArray(a.codeLinks) ? a.codeLinks : undefined,
                    linkedMemoryIds: Array.isArray(a.linkedMemoryIds) ? a.linkedMemoryIds : undefined,
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
                setSprintState(workspaceRoot, String(a.id ?? ''), String(a.state ?? 'future'));
                return listSprints(workspaceRoot);
            },
            // Automation rules — trigger → action over the project board.
            'track-automations': () => { ensureProject(workspaceRoot); return listAutomations(workspaceRoot); },
            'track-create-automation': (a) => {
                createAutomation(workspaceRoot, {
                    name: String(a.name ?? 'Rule'),
                    trigger: (typeof a.trigger === 'string' ? a.trigger : 'created'),
                    condition: typeof a.condition === 'string' ? a.condition : undefined,
                    actions: Array.isArray(a.actions) ? a.actions : [],
                });
                return listAutomations(workspaceRoot);
            },
            'track-update-automation': (a) => {
                const patch = (a.patch && typeof a.patch === 'object' ? a.patch : {});
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
                addMember(workspaceRoot, { id: String(a.id ?? ''), name: typeof a.name === 'string' ? a.name : undefined, role: (typeof a.role === 'string' ? a.role : 'member') });
                return listMembers(workspaceRoot);
            },
            'track-update-member-role': (a) => {
                updateMemberRole(workspaceRoot, String(a.id ?? ''), (typeof a.role === 'string' ? a.role : 'member'));
                return listMembers(workspaceRoot);
            },
            'track-remove-member': (a) => {
                removeMember(workspaceRoot, String(a.id ?? ''));
                return listMembers(workspaceRoot);
            },
            // Pull repo collaborators into the roster (role-mapped). Token resolved
            // server-side; never returned to the renderer.
            'track-sync-members': async (a) => {
                const cfg = resolveGithubConfigForWorkspace(workspaceRoot, typeof a.repo === 'string' ? a.repo : undefined);
                if (!cfg.repo)
                    return { error: 'No repository configured. Set one in Settings → Connectors → GitHub Track sync.' };
                if (!cfg.token)
                    return { error: 'No token. Add one in Settings → Connectors → GitHub Track sync, set GITHUB_TOKEN/GH_TOKEN, or use a static token ref in Settings → Connectors.' };
                return await importMembersFromGithub(workspaceRoot, { repo: cfg.repo, token: cfg.token, fetchImpl: fetch, dryRun: a.dryRun === true });
            },
            // External sync — GitHub Issues. The token is resolved server-side from
            // config.json/env and NEVER returned to the renderer.
            'track-sync-config': () => {
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
            'track-sync': async (a) => {
                const direction = a.direction === 'export' ? 'export' : 'import';
                const dryRun = a.dryRun !== false; // default to dry-run unless explicitly false
                const cfg = resolveGithubConfigForWorkspace(workspaceRoot, typeof a.repo === 'string' ? a.repo : undefined);
                if (!cfg.repo)
                    return { error: 'No repository configured. Set one in Settings → Connectors → GitHub Track sync.' };
                if (!cfg.token)
                    return { error: 'No token. Add one in Settings → Connectors → GitHub Track sync, set GITHUB_TOKEN/GH_TOKEN, or use a static token ref in Settings → Connectors.' };
                const opts = { repo: cfg.repo, token: cfg.token, fetchImpl: fetch, dryRun };
                return direction === 'export' ? await exportToGithub(workspaceRoot, opts) : await importFromGithub(workspaceRoot, opts);
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
                const graph = buildBaseGraph(workspaceRoot);
                saveAtlasGraph(workspaceRoot, graph);
                // Sync the fresh build up so other clients / the dashboard can serve it.
                if (getCliKnobs().brainUrl)
                    await callBrainAtlas('atlas_put', { workspaceTag: atlasWorkspaceTag(workspaceRoot), graph });
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
                const llm = llmForSession(activeAgent.sessionKey);
                if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
                    return { error: 'No model configured — set a provider/model (and API key) in Settings before enriching the atlas.' };
                }
                const caller = async ({ system, user, signal, tool }) => {
                    // STRUCTURED OUTPUT — forward the enrich tool as a forced tool_choice so
                    // output is schema-shaped + consistent across models (mirrors the CLI
                    // adapter); fall back to message content when the model answers inline.
                    const tools = tool ? [{ name: tool.name, description: tool.description ?? '', inputSchema: tool.parameters }] : [];
                    const resp = await callOpenAI(llm, [
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                    ], tools, { effort: 'low', signal, ...(tool ? { tool_choice: { type: 'function', function: { name: tool.name } } } : {}) });
                    const argsText = resp?.tool_calls?.[0]?.function?.arguments;
                    if (typeof argsText === 'string' && argsText.trim())
                        return argsText;
                    return resp?.content ?? '';
                };
                const res = await enrichAtlasGraph(graph, caller);
                saveAtlasGraph(workspaceRoot, res.graph);
                if (getCliKnobs().brainUrl)
                    await callBrainAtlas('atlas_put', { workspaceTag: atlasWorkspaceTag(workspaceRoot), graph: res.graph });
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
                if (!path)
                    return { error: 'No file path given.' };
                const llm = llmForSession(activeAgent.sessionKey);
                if (!llm || (!llm.apiKey && (llm.provider ?? 'openai') === 'openai')) {
                    return { error: 'No model configured — set a provider/model (and API key) in Settings.' };
                }
                // Working-tree diff vs HEAD; fall back to file content for untracked files.
                let diff = await git(['diff', '--no-color', 'HEAD', '--', path], workspaceRoot).catch(() => '');
                if (!diff.trim()) {
                    let content = '';
                    try {
                        content = (await import('node:fs')).readFileSync(`${workspaceRoot}/${path}`, 'utf8');
                    }
                    catch {
                        content = '';
                    }
                    diff = content ? `NEW/UNTRACKED FILE ${path}:\n${content.slice(0, 16000)}` : '';
                }
                if (!diff.trim())
                    return { error: 'No diff available for this file.' };
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
                    raw = resp?.content ?? '';
                }
                catch (e) {
                    return { path, error: `Model call failed: ${e instanceof Error ? e.message : String(e)}` };
                }
                const parsed = extractAtlasJson(raw);
                if (!parsed || typeof parsed !== 'object')
                    return { path, error: 'Could not parse the model response.' };
                const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : []);
                const risk = ['low', 'medium', 'high'].includes(String(parsed.risk)) ? String(parsed.risk) : 'medium';
                return {
                    path,
                    assessment: { summary: typeof parsed.summary === 'string' ? parsed.summary : '', risk, checklist: arr(parsed.checklist), concerns: arr(parsed.concerns) },
                };
            },
            'requirement-list': () => listRequirements(workspaceRoot),
            'requirement-create': async (a) => {
                const created = createRequirement(workspaceRoot, { title: String(a.title ?? ''), sessionKey: activeAgent.sessionKey });
                await captureRequirementNote(created, 'created');
                return getRequirement(workspaceRoot, created.id) ?? created;
            },
            'requirement-update': async (a) => {
                const id = String(a.id ?? '');
                const patch = {};
                let change = '';
                if (a.status !== undefined) {
                    if (!isRequirementStatus(a.status))
                        return { error: `Unknown requirement status "${String(a.status)}".` };
                    patch.status = a.status;
                    change = `status → ${a.status}`;
                }
                if (a.priority !== undefined) {
                    if (!isRequirementPriority(a.priority))
                        return { error: `Unknown requirement priority "${String(a.priority)}".` };
                    patch.priority = a.priority;
                    if (!change)
                        change = `priority → ${a.priority}`;
                }
                if (typeof a.criterion === 'string' && a.criterion.trim()) {
                    const existing = getRequirement(workspaceRoot, id);
                    if (!existing)
                        return { error: `No requirement "${id}".` };
                    patch.acceptanceCriteria = [...existing.acceptanceCriteria, a.criterion.trim()];
                    change = change ? `${change}; criterion added` : 'criterion added';
                }
                const updated = updateRequirement(workspaceRoot, id, patch);
                if (!updated)
                    return { error: `No requirement "${id}".` };
                if (change)
                    await captureRequirementNote(updated, change);
                return getRequirement(workspaceRoot, updated.id) ?? updated;
            },
            'requirement-delete': (a) => {
                const id = String(a.id ?? '');
                return { ok: deleteRequirement(workspaceRoot, id) };
            },
            'requirement-seed-plan': async (a) => {
                const id = String(a.id ?? '');
                const req = getRequirement(workspaceRoot, id);
                if (!req)
                    return { error: `No requirement "${id}".` };
                if (req.acceptanceCriteria.length === 0)
                    return { error: 'This requirement has no acceptance criteria to seed a plan from.' };
                const plan = seedPlanFromRequirement(workspaceRoot, { id: req.id, acceptanceCriteria: req.acceptanceCriteria }, activeAgent.sessionKey);
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
                if (!req)
                    return { error: `No requirement "${id}".` };
                if (req.acceptanceCriteria.length === 0)
                    return { error: 'This requirement has no acceptance criteria yet — add some first.' };
                updateRequirement(workspaceRoot, id, { status: 'ready' });
                const { actions } = syncRequirementPlanTrack(workspaceRoot, activeAgent.sessionKey);
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
            'annotation-list': (a) => listAnnotations(workspaceRoot, withSessionScope(annotationFilterFromArgs(a), a, activeAgent.sessionKey)).map((rec) => annotateStale(workspaceRoot, rec)),
            'annotation-create': async (a) => {
                const type = a.type;
                if (!isAnnotationTargetKind(type))
                    return { error: `Unknown annotation target kind "${String(type)}".` };
                const body = String(a.body ?? '').trim();
                if (!body)
                    return { error: 'Annotation body must be a non-empty string.' };
                if (a.status !== undefined && !isAnnotationStatus(a.status))
                    return { error: `Unknown annotation status "${String(a.status)}".` };
                if (a.severity !== undefined && !isAnnotationSeverity(a.severity))
                    return { error: `Unknown annotation severity "${String(a.severity)}".` };
                const input = { type, body, sessionKey: activeAgent?.sessionKey };
                if (typeof a.targetId === 'string' && a.targetId)
                    input.targetId = a.targetId;
                if (typeof a.requirementId === 'string' && a.requirementId)
                    input.requirementId = a.requirementId;
                if (typeof a.taskId === 'string' && a.taskId)
                    input.taskId = a.taskId;
                if (typeof a.artifactId === 'string' && a.artifactId)
                    input.artifactId = a.artifactId;
                if (typeof a.suggestedText === 'string' && a.suggestedText.trim())
                    input.suggestedText = a.suggestedText;
                if (typeof a.author === 'string' && a.author.trim())
                    input.author = a.author.trim();
                if (a.status !== undefined && isAnnotationStatus(a.status))
                    input.status = a.status;
                if (a.severity !== undefined && isAnnotationSeverity(a.severity))
                    input.severity = a.severity;
                const anchor = annotationAnchorFromArgs(a.anchor);
                if (anchor)
                    input.anchor = anchor;
                try {
                    const created = createAnnotation(workspaceRoot, input);
                    await captureAnnotationNote(created, 'created');
                    return getAnnotation(workspaceRoot, created.id) ?? created;
                }
                catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
            'annotation-set-status': async (a) => {
                const id = String(a.id ?? '');
                if (!isAnnotationStatus(a.status))
                    return { error: `Unknown annotation status "${String(a.status)}".` };
                const updated = setAnnotationStatus(workspaceRoot, id, a.status);
                if (!updated)
                    return { error: `No annotation "${id}".` };
                await captureAnnotationNote(updated, `status → ${updated.status}`);
                const linked = getAnnotation(workspaceRoot, updated.id);
                return linked ? annotateStale(workspaceRoot, linked) : annotateStale(workspaceRoot, updated);
            },
            // §6 COMMENT THREADS — append a comment to an annotation's discussion.
            'annotation-add-comment': async (a) => {
                const id = String(a.id ?? '');
                const body = typeof a.body === 'string' ? a.body.trim() : '';
                if (!body)
                    return { error: 'Comment body must be a non-empty string.' };
                const author = typeof a.author === 'string' && a.author.trim() ? a.author.trim() : undefined;
                try {
                    const updated = addAnnotationComment(workspaceRoot, id, body, author);
                    if (!updated)
                        return { error: `No annotation "${id}".` };
                    await captureAnnotationNote(updated, `comment: ${body.replace(/\s+/g, ' ').slice(0, 80)}`);
                    const linked = getAnnotation(workspaceRoot, updated.id);
                    return annotateStale(workspaceRoot, linked ?? updated);
                }
                catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
            // Render the (optionally filtered) annotations as agent-readable markdown
            // for the renderer to drop into the chat composer — the "export feedback
            // to the session" path. Pure render; the composer draft is set renderer-side.
            'annotation-export': async (a) => {
                const records = listAnnotations(workspaceRoot, withSessionScope(annotationFilterFromArgs(a), a, activeAgent.sessionKey));
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
            'artifact-list': (a) => listArtifacts(workspaceRoot, withSessionScope(artifactFilterFromArgs(a), a, activeAgent.sessionKey)),
            'artifact-create': async (a) => {
                if (!isArtifactKind(a.kind))
                    return { error: `Unknown artifact kind "${String(a.kind)}".` };
                const title = String(a.title ?? '').trim();
                if (!title)
                    return { error: 'Artifact title must be a non-empty string.' };
                if (a.status !== undefined && !isArtifactStatus(a.status))
                    return { error: `Unknown artifact status "${String(a.status)}".` };
                if (a.format !== undefined && !isArtifactFormat(a.format))
                    return { error: `Unknown artifact format "${String(a.format)}".` };
                const input = { kind: a.kind, title, sessionKey: activeAgent?.sessionKey };
                if (isArtifactStatus(a.status))
                    input.status = a.status;
                if (isArtifactFormat(a.format))
                    input.format = a.format;
                if (typeof a.path === 'string' && a.path.trim())
                    input.path = a.path.trim();
                if (typeof a.content === 'string' && a.content.length)
                    input.content = a.content;
                if (typeof a.summary === 'string' && a.summary.trim())
                    input.summary = a.summary;
                if (typeof a.requirementId === 'string' && a.requirementId)
                    input.requirementId = a.requirementId;
                if (typeof a.taskId === 'string' && a.taskId)
                    input.taskId = a.taskId;
                try {
                    const created = createArtifact(workspaceRoot, input);
                    await captureArtifactNote(created, 'created');
                    return getArtifact(workspaceRoot, created.id) ?? created;
                }
                catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
            'artifact-update': async (a) => {
                const id = String(a.id ?? '');
                const patch = {};
                let change = '';
                if (a.status !== undefined) {
                    if (!isArtifactStatus(a.status))
                        return { error: `Unknown artifact status "${String(a.status)}".` };
                    patch.status = a.status;
                    change = `status → ${a.status}`;
                }
                if (a.summary !== undefined) {
                    if (typeof a.summary !== 'string')
                        return { error: 'Artifact summary must be a string.' };
                    patch.summary = a.summary;
                    change = change ? `${change}; summary updated` : 'summary updated';
                }
                const updated = updateArtifact(workspaceRoot, id, patch);
                if (!updated)
                    return { error: `No artifact "${id}".` };
                if (change)
                    await captureArtifactNote(updated, change);
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
                if (!rec)
                    return { error: `No artifact "${id}".` };
                if (rec.path) {
                    const entry = readWorkspaceEntry(workspaceRoot, rec.path);
                    if (entry.error)
                        return { id, error: entry.error };
                    if (entry.binary)
                        return { id, error: 'Artifact file is binary — open it externally.' };
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
                if (content === null)
                    return { error: 'Artifact content must be a string.' };
                const rec = getArtifact(workspaceRoot, id);
                if (!rec)
                    return { error: `No artifact "${id}".` };
                if (rec.path) {
                    const res = writeWorkspaceEntry(workspaceRoot, rec.path, content);
                    if (!res.ok)
                        return { id, error: res.error ?? 'write failed', conflict: res.conflict };
                    fileListCache.invalidate(workspaceRoot);
                    const updated = updateArtifact(workspaceRoot, id, {}); // bump updatedAt so the preview re-resolves
                    await captureArtifactNote(updated ?? rec, 'saved to workspace');
                    return { id, ok: true, path: rec.path };
                }
                const updated = updateArtifact(workspaceRoot, id, { content }, { editedBy: 'user', note: 'edited in desktop' });
                if (!updated)
                    return { error: `No artifact "${id}".` };
                await captureArtifactNote(updated, 'content saved');
                return { id, ok: true };
            },
            // §AV-1 — restore a prior version's content as a NEW version (append-only).
            // For a file-backed artifact whose content lives on disk, also writes the
            // restored content back through the same safe workspace write.
            'artifact-revert': async (a) => {
                const id = String(a.id ?? '');
                const v = Number(a.version);
                if (!Number.isInteger(v))
                    return { error: 'version must be an integer.' };
                const updated = revertArtifact(workspaceRoot, id, v, { editedBy: 'user' });
                if (!updated)
                    return { error: `No artifact "${id}" or version v${v}.` };
                if (updated.path && typeof updated.content === 'string') {
                    const res = writeWorkspaceEntry(workspaceRoot, updated.path, updated.content);
                    if (res.ok)
                        fileListCache.invalidate(workspaceRoot);
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
            'review-diff': async () => runReviewTask(activeAgent.sessionKey),
            'review-rerun': async () => runReviewTask(activeAgent.sessionKey),
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
                if (!isFindingStatus(status))
                    return { ok: false, error: `Unknown finding status "${String(status)}".` };
                return { ok: !!updateReviewFinding(workspaceRoot, String(a.id ?? ''), status, isoNow()) };
            },
            'review-apply-suggestion': async (a) => {
                // Best-effort: apply the finding's unified-diff patch with `git apply`.
                const run = getLatestReview(workspaceRoot);
                const f = run?.findings.find((x) => x.id === String(a.id ?? ''));
                if (!f?.patch)
                    return { ok: false, error: 'This finding has no applicable patch — use "Ask agent to fix" instead.' };
                const tmp = path.join(getStateDir(workspaceRoot), `review-${Date.now().toString(36)}.patch`);
                try {
                    fs.writeFileSync(tmp, f.patch.endsWith('\n') ? f.patch : f.patch + '\n');
                    const check = await git(['apply', '--check', tmp], wsGit.gitRoot ?? workspaceRoot);
                    await git(['apply', tmp], wsGit.gitRoot ?? workspaceRoot);
                    fs.rmSync(tmp, { force: true });
                    updateReviewFinding(workspaceRoot, f.id, 'applied', isoNow());
                    return { ok: true };
                }
                catch (err) {
                    try {
                        fs.rmSync(tmp, { force: true });
                    }
                    catch { /* ignore */ }
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
                if (!f)
                    return { ok: false, error: 'finding not found' };
                const sessionKey = activeAgent.sessionKey;
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
                    const noop = () => { };
                    const cb = {
                        onStatusUpdate: (text) => { if (text)
                            taskProgress(task.id, 'working', text.slice(0, 80)); },
                        onToolStart: noop, onToolEnd: noop, onAssistantDelta: noop, onAssistantTurnStart: noop,
                        onAssistantTurnEnd: noop, onReasoningDelta: noop, onUsageUpdate: noop, onPlanUpdate: noop,
                    };
                    await fixer.runTurn(prompt, cb);
                    taskProgress(task.id, 'rerunning-review', 'checking the updated diff');
                    updateReviewFinding(workspaceRoot, f.id, 'fixed', isoNow());
                    // Re-run the review over the new working diff so the gate + findings refresh.
                    const rerun = await runReview();
                    const done = updateBackgroundTask(workspaceRoot, task.id, {
                        status: 'completed',
                        result: { findingId: f.id, files: rerun.files, findings: rerun.findings.length },
                    });
                    if (done)
                        emitTaskEvent('completed', done);
                    return { ok: true, findingId: f.id, files: rerun.files, run: rerun };
                }
                catch (err) {
                    const failed = updateBackgroundTask(workspaceRoot, task.id, { status: 'failed', error: `Fix agent failed: ${err instanceof Error ? err.message : err}` });
                    if (failed)
                        emitTaskEvent('failed', failed);
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
            'schedule-list': () => loadSchedules(workspaceRoot).filter((s) => s.owner === activeAgent.sessionKey),
            'schedule-add': (a) => {
                const kind = a.kind === 'once' ? 'once' : 'cron';
                const expr = String(a.expr ?? '').trim();
                const command = String(a.command ?? '').trim();
                if (!command.startsWith('/'))
                    return { ok: false, error: 'Command must start with "/".' };
                let nextRun;
                if (kind === 'cron') {
                    const cron = parseCron(expr);
                    if (!cron)
                        return { ok: false, error: `Invalid cron expression: "${expr}" (need 5 fields).` };
                    nextRun = nextCronFire(cron, new Date()).toISOString();
                }
                else {
                    const at = new Date(expr);
                    if (Number.isNaN(at.getTime()))
                        return { ok: false, error: `Invalid date/time: "${expr}".` };
                    nextRun = at.toISOString();
                }
                const rec = addSchedule(workspaceRoot, { kind, expr, command, owner: activeAgent.sessionKey, nextRun, enabled: true });
                return { ok: true, schedule: rec };
            },
            'schedule-remove': (a) => ({ ok: removeSchedule(workspaceRoot, String(a.id ?? '')) }),
            'schedule-toggle': (a) => ({ ok: setScheduleEnabled(workspaceRoot, String(a.id ?? ''), a.enabled !== false), enabled: a.enabled !== false }),
            // DESK-4c — one snapshot powering the whole Settings dialog. All values
            // come from the stores the CLI itself reads/writes.
            'config-snapshot': () => {
                const fresh = loadConfig();
                llm = fresh.llm ?? llm;
                syncActiveSessionLlm(llm);
                const cli = fresh.cli;
                const mcpStatuses = new Map(mcpClient.getStatuses().map((s) => [s.serverId, s]));
                const providerEntries = Object.entries(fresh.providers ?? {});
                const defaultProviderMatch = matchingDefaultProvider(fresh.providers, fresh.llm);
                const defaultProviderName = defaultProviderMatch.name;
                const workspacePrefs = readPreferences(workspaceRoot);
                const activeMode = resolveActiveMode(workspaceRoot, activeAgent.sessionKey);
                const connectorItems = listConnectors(workspaceRoot);
                return {
                    model: fresh.llm?.model ?? llm.model,
                    provider: fresh.llm?.provider ?? llm.provider,
                    endpoint: fresh.llm?.endpoint ?? null,
                    fallbackModel: cli?.fallbackModel ?? null,
                    workspaceRoot,
                    sandbox: cli?.sandbox ?? 'off',
                    prefs: mergeSessionModePrefs(workspacePrefs, activeMode),
                    workspacePrefs,
                    sessionMode: getSessionMode(workspaceRoot, activeAgent.sessionKey),
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
                    providers: providerEntries.map(([name, p]) => ({ name, provider: p.provider, model: p.model, endpoint: p.endpoint ?? null, hasKey: !!p.apiKey, models: p.models ?? [], apiVersion: p.apiVersion ?? null })),
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
            'usage-breakdown': () => buildUsageBreakdown({ parent: activeAgent.sessionUsage, children: [], offload: undefined, prefixStability: activeAgent.getPrefixStability() }),
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
                const a = activeAgent;
                // DESK-6t — with LAZY history, a freshly-resumed chat hasn't loaded its
                // transcript into the agent yet, so the agent estimate would read ~0.
                // Fall back to the resumed transcript's token estimate (from the cache
                // populated on resume) so the ring isn't wrong while you're browsing.
                const agentTokens = Number(a.getCurrentContextTokens?.() ?? a.lastSeenPromptTokens ?? 0);
                // OOM-safe ring estimate: a lazily-resumed chat hasn't loaded history into
                // the agent yet, so approximate context from the transcript's BYTE SIZE
                // (~4 bytes/token) — O(1), no content read, no cache dependency. The
                // agent's authoritative prompt_tokens takes over once a turn runs.
                const sizeEstimate = Math.round(transcriptSizeBytes(workspaceRoot, activeAgent.sessionKey) / 4);
                const used = Math.max(agentTokens, sizeEstimate);
                const model = activeAgent.getModel?.() ?? llm.model;
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
                const p = readPlan(workspaceRoot, activeAgent.sessionKey);
                return { items: p.items, explanation: p.explanation };
            },
            // GOAL-BANNER — the structured active goal for THIS session, so the chat
            // can pin it with status + controls (vs the plain-text /goal command out).
            'goal-state': () => readGoal(workspaceRoot, activeAgent.sessionKey) ?? null,
            // Edit the active goal's text in place (no re-kickoff) for the banner's
            // inline editor. Returns the updated goal so the banner refreshes.
            'action:goal-edit': (args) => {
                const text = typeof args.text === 'string' ? args.text.trim() : '';
                if (!text)
                    return { ok: false, error: 'Goal text cannot be empty.' };
                try {
                    const g = editGoal(workspaceRoot, activeAgent.sessionKey, { text });
                    return g ? { ok: true, goal: g } : { ok: false, error: 'No active goal to edit.' };
                }
                catch (err) {
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
                const sk = activeAgent.sessionKey;
                const goal = readGoal(workspaceRoot, sk);
                if (!goal)
                    return { action: 'none' };
                const lastTurnToolCalls = activeAgent.lastTurnToolCalls ?? 0;
                const lastGoalTransition = activeAgent.lastGoalTransition;
                // Terminal states the model itself reached this turn.
                if (lastGoalTransition === 'complete' || goal.status === 'complete') {
                    goalStrikes.delete(sk);
                    return { action: 'complete', notice: `🎯 Goal achieved — ${goal.blockedReason ?? 'evidence on record.'}` };
                }
                if (lastGoalTransition === 'blocked' || goal.status === 'blocked') {
                    goalStrikes.delete(sk);
                    return { action: 'blocked', notice: `🚧 Goal blocked: ${goal.blockedReason ?? '(no reason)'} — resolve it, then /goal resume.` };
                }
                if (goal.status !== 'active')
                    return { action: 'none' };
                let strikes = goalStrikes.get(sk) ?? 0;
                if (lastTurnToolCalls > 0)
                    strikes = 0;
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
            'plan-history': () => readPlanHistory(workspaceRoot, activeAgent.sessionKey),
            // Record an approval / changes-requested decision against THIS session's
            // current plan (snapshotting it), then capture a best-effort memory note and
            // link it back — exactly like the CLI's /plan approve·request-changes.
            'plan-record-decision': async (a) => {
                const verdict = a.verdict;
                if (verdict !== 'approved' && verdict !== 'changes-requested')
                    return { error: `Unknown plan verdict "${String(a.verdict)}".` };
                const feedback = typeof a.feedback === 'string' ? a.feedback.trim() : '';
                if (verdict === 'changes-requested' && !feedback)
                    return { error: 'Requesting changes needs feedback to return to the session.' };
                const cur = readPlan(workspaceRoot, activeAgent.sessionKey);
                if (cur.items.length === 0)
                    return { error: 'There is no plan to review in this session yet.' };
                const decision = recordPlanDecision(workspaceRoot, activeAgent.sessionKey, {
                    verdict, feedback: feedback || undefined, planSnapshot: cur.items, explanation: cur.explanation, requirementId: cur.requirementId,
                });
                try {
                    const memoryId = await emitAgentEvent({ mcpClient, sessionKey: activeAgent.sessionKey }, {
                        kind: 'agent_output',
                        summary: `Plan ${decision.verdict} (${decision.id}) — ${decision.planSnapshot.length} item(s)${decision.feedback ? `: ${decision.feedback}` : ''}`,
                        payload: { planDecisionId: decision.id, verdict: decision.verdict, feedback: decision.feedback, requirementId: decision.requirementId, itemCount: decision.planSnapshot.length },
                    });
                    if (memoryId)
                        linkPlanDecision(workspaceRoot, activeAgent.sessionKey, decision.id, memoryId);
                }
                catch { /* advisory — never break the action */ }
                // §1 — requesting changes launches a real, visible background revision
                // task. The decision is already saved, so a task-launch failure still
                // returns ok (the renderer keeps the feedback draft + surfaces the error).
                if (verdict === 'changes-requested') {
                    try {
                        const task = runPlanRevisionTask(activeAgent.sessionKey, decision, feedback);
                        return { ok: true, decision, task: taskEventView(task) };
                    }
                    catch (err) {
                        return { ok: true, decision, taskError: err instanceof Error ? err.message : String(err) };
                    }
                }
                return { ok: true, decision };
            },
            'search-transcript': (args) => {
                const query = typeof args.q === 'string' ? args.q : '';
                // OOM-safe: search a bounded recent window (50 capped results anyway).
                return searchTranscript(readTranscriptTail(workspaceRoot, activeAgent.sessionKey, 5000), query, { limit: 50 })
                    .map((m) => ({ index: m.index ?? 0, role: m.role ?? '?', snippet: m.snippet ?? '' }));
            },
            'chapters': () => listChapters(readTranscriptTail(workspaceRoot, activeAgent.sessionKey, 2000)),
            // DESK-5p — render a resumed session's FULL history: user/assistant prose
            // verbatim AND the real tool calls (name + arg-derived summary + output
            // preview + ok), reconstructed from the persisted OpenAI-format entries
            // (assistant `tool_calls` request the call; the `tool` result message
            // carries name + content + isError). Consecutive tool activity collapses
            // into one tool-group row, exactly like the live stream — so the resumed
            // view shows the same expandable tool cards instead of a bare count.
            'transcript': (args) => {
                const key = typeof args.sessionKey === 'string' ? args.sessionKey : activeAgent.sessionKey;
                // OOM-safe: bounded TAIL read (not the full-history cache) — the UI only
                // renders the last 400 rows, so ~1200 recent entries is plenty and the
                // host never allocates a multi-megabyte transcript for rendering.
                const entries = readTranscriptTail(workspaceRoot, key, 1200);
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
                    const raw = readWorkerTranscript(workspaceRoot, id, 400);
                    return { id, kind, role: meta?.role, goal: meta?.goal, status: meta?.status, rows: workerEventsToRows(raw) };
                }
                // §1/§2/§3 — a DURABLE task (plan revision / review / verification). The
                // task agent ran under its own internal session key (carried in the
                // task's transcript ref as parentSessionKey); reconstruct that turn's
                // transcript exactly like a chat so the user sees what the task did.
                if (kind === 'task') {
                    const taskRec = getBackgroundTask(workspaceRoot, id);
                    const taskKey = parent || taskRec?.transcript?.parentSessionKey || '';
                    const entries = (taskKey ? readTranscriptTail(workspaceRoot, taskKey, 1200) : []);
                    const rows = reconstructTranscriptRows(entries).slice(-400);
                    return { id, kind, role: taskRec?.kind, goal: taskRec?.title, status: taskRec?.status, rows };
                }
                // Child agent: its history lives at childSessionKey(parent, id); an
                // isolated-worktree child persists under its own childWorkspaceRoot.
                const session = listSessions(workspaceRoot).find((s) => s.id === id);
                const childKey = parent ? childSessionKey(parent, id) : id;
                const readRoot = session?.childWorkspaceRoot ?? workspaceRoot;
                // OOM-safe: bounded tail (the task view renders the last 400 rows).
                const entries = readTranscriptTail(readRoot, childKey, 1200);
                return { id, kind, role: session?.role, goal: session?.prompt, status: session?.status, rows: reconstructTranscriptRows(entries).slice(-400) };
            },
            // DESK-6w — a workflow run's full breakdown for the Claude-/workflows-style
            // card: each phase with its spawned child AGENTS resolved to live stats
            // (role/label/status + tokens, tool calls, wall-clock). Step-based runs
            // (no phases) fall back to a flat step list.
            'workflow-detail': (args) => {
                const slug = typeof args.slug === 'string' ? args.slug : '';
                const run = readRun(workspaceRoot, slug);
                if (!run)
                    return null;
                const byId = new Map(listSessions(workspaceRoot).map((s) => [s.id, s]));
                const resolveAgents = (childIds) => childIds.map((id) => {
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
                for (const p of phases) {
                    totalAgents += p.agents.length;
                    for (const a of p.agents)
                        totalTokens += a.tokens;
                }
                return { slug: run.slug, kind: run.kind, status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt, phases, steps, totalAgents, totalTokens };
            },
            'export-chat': (args) => {
                const format = args.format === 'json' ? 'json' : 'md';
                const entries = loadTranscript(workspaceRoot, activeAgent.sessionKey);
                const exportedAt = new Date().toISOString();
                const meta = { sessionKey: activeAgent.sessionKey, exportedAt };
                return {
                    filename: exportFileName(activeAgent.sessionKey, format, exportedAt),
                    content: format === 'json' ? exportTranscriptJson(entries, meta) : exportTranscriptMarkdown(entries, meta),
                };
            },
            // DESK-4e — content search (the Files panel's "?text" mode, observed).
            'search-content': async (args) => {
                const query = typeof args.q === 'string' ? args.q : '';
                if (!query.trim())
                    return [];
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
                if (!rule)
                    throw new Error('Empty permission rule.');
                const fresh = loadConfig();
                fresh.cli = fresh.cli ?? {};
                fresh.cli.permissions = fresh.cli.permissions ?? {};
                const allow = (fresh.cli.permissions.allow = fresh.cli.permissions.allow ?? []);
                if (!allow.includes(rule))
                    allow.push(rule);
                saveConfig(fresh);
                return { ok: true, rule };
            },
            // T7 — full permission-rules editor (add/remove on allow OR deny), via the
            // pure tested applyRuleEdit. Shared config.json — the CLI gate reads it too.
            'action:rule-edit': (args) => {
                const op = args.op === 'remove' ? 'remove' : 'add';
                const kind = args.kind === 'deny' ? 'deny' : 'allow';
                const rule = typeof args.rule === 'string' ? args.rule : '';
                if (op === 'add' && !rule.trim())
                    throw new Error('Empty permission rule.');
                const fresh = loadConfig();
                fresh.cli = fresh.cli ?? {};
                fresh.cli.permissions = applyRuleEdit(fresh.cli.permissions, op, kind, rule);
                saveConfig(fresh);
                return { ok: true, permissions: fresh.cli.permissions };
            },
            // DESK-4e — user-typed terminal commands (the Terminal panel's input
            // row). Equivalent to the CLI's `!` shell escape: the USER runs it, so
            // no approval gate; cwd is the workspace.
            'action:term-exec': (args) => {
                const cmd = typeof args.cmd === 'string' ? args.cmd : '';
                if (!cmd.trim())
                    return { out: '', code: 0 };
                return new Promise((resolve) => {
                    exec(cmd, { cwd: workspaceRoot, timeout: 20_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
                        fileListCache.invalidate(workspaceRoot);
                        resolve({
                            out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20_000),
                            code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
                        });
                    });
                });
            },
            // T5 — save an editor buffer. A USER edit, so no approval gate (same posture
            // as action:term-exec). writeWorkspaceEntry enforces escape/symlink/stale
            // guards and returns {ok}|{conflict}|{error}; the renderer surfaces it.
            'action:file-save': (args) => {
                const result = writeWorkspaceEntry(workspaceRoot, typeof args.path === 'string' ? args.path : '', typeof args.content === 'string' ? args.content : '', { expectedMtimeMs: typeof args.expectedMtimeMs === 'number' ? args.expectedMtimeMs : undefined });
                if (result.ok)
                    fileListCache.invalidate(workspaceRoot);
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
                        const sk = activeAgent.sessionKey;
                        if (rest === 'clear') {
                            clearGoal(workspaceRoot, sk);
                            goalStrikes.delete(sk);
                            return { lines: ['Goal cleared.'] };
                        }
                        if (rest === 'pause') {
                            const g = pauseGoal(workspaceRoot, sk);
                            return { lines: g ? ['Goal paused — /goal resume to continue.'] : ['No active goal to pause.'] };
                        }
                        if (rest === 'resume') {
                            const g = resumeGoal(workspaceRoot, sk);
                            if (!g)
                                return { lines: ['No goal to resume.'] };
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
                            try {
                                appendTranscriptEntry(workspaceRoot, sk, { role: 'user', content: g.text });
                            }
                            catch { /* listing is best-effort */ }
                            // Seed a visible starter plan so the Plan panel populates the
                            // instant the goal is set (instead of waiting on the model to call
                            // update_plan). The kickoff prompt tells the agent to replace it.
                            try {
                                updatePlan(workspaceRoot, { plan: [{ step: g.text.slice(0, 200), status: 'in_progress' }], explanation: 'Goal kickoff — the agent will break this down via update_plan.' }, sk);
                            }
                            catch { /* plan seed is best-effort */ }
                            return { lines: [`Goal set: ${g.text}`, `status: ${g.status} — working on it…`], startTurn: buildGoalKickoffPrompt(g, 'start') };
                        }
                        const g = readGoal(workspaceRoot, sk);
                        return { lines: g ? [`Goal: ${g.text}`, `status: ${g.status} · iteration ${g.budget.iterationsUsed}/${formatBudget(g.budget.maxIterations)}`] : ['No active goal.', 'Usage: /goal <text> · /goal pause · /goal resume · /goal clear'] };
                    }
                    case 'plan': {
                        const text = formatPlan(readPlan(workspaceRoot, activeAgent.sessionKey));
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
                                ? ws.slice(0, 20).map((w) => `${w.id} · ${w.status ?? '?'} · ${(w.task ?? '').slice(0, 70)}`)
                                : ['No workers in this workspace.'],
                        };
                    }
                    case 'ps': {
                        const tasks = collectRunningTasks(workspaceRoot);
                        return { lines: tasks.length ? tasks.map((t) => `${t.kind} · ${t.id} · ${t.label}`) : ['Nothing running.'] };
                    }
                    case 'tools': {
                        try {
                            const res = await mcpClient.listTools();
                            const names = (res.tools ?? []).map((t) => t.name).filter(Boolean);
                            return { lines: names.length ? [`${names.length} MCP tools:`, ...names.slice(0, 60)] : ['No MCP tools (offline mode — local tools only).'] };
                        }
                        catch {
                            return { lines: ['No MCP tools (offline mode — local tools only).'] };
                        }
                    }
                    case 'status': {
                        const st = mcpClient.getStatuses();
                        return {
                            lines: [
                                `model: ${activeAgent.getModel?.() ?? llm.model} (${llm.provider})`,
                                `workspace: ${workspaceRoot}`,
                                `session: ${activeAgent.sessionKey}`,
                                ...st.map((x) => `mcp ${x.serverId}: ${x.status}${x.identity !== 'unknown' ? ` (${x.identity})` : ''}`),
                                st.length === 0 ? 'mcp: no servers configured' : '',
                            ].filter(Boolean),
                        };
                    }
                    case 'briefing': {
                        const a = activeAgent;
                        const sources = a.lastBriefingSources ?? [];
                        const details = a.lastBriefingDetails ?? {};
                        if (!sources.length && !Object.keys(details).length)
                            return { lines: ['No briefing yet — run a turn first.'] };
                        return {
                            lines: [
                                sources.length ? `Sources queried: ${sources.join(', ')}` : 'Sources queried: —',
                                ...Object.entries(details).slice(0, 12).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v)?.slice(0, 120)}`),
                            ],
                        };
                    }
                    case 'memory':
                    case 'recall': {
                        if (!rest)
                            return { lines: [`Usage: /${cmd} <query>`] };
                        try {
                            const result = await mcpClient.callTool(cmd === 'memory' ? 'memory_search' : 'cognitive_recall', { query: rest });
                            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                            return { lines: text.split('\n').slice(0, 50) };
                        }
                        catch (err) {
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
                if (typeof args.provider === 'string' && args.provider.trim())
                    llmCfg.provider = args.provider.trim();
                if (typeof args.model === 'string' && args.model.trim())
                    llmCfg.model = args.model.trim();
                if (typeof args.endpoint === 'string')
                    llmCfg.endpoint = args.endpoint.trim() || PROVIDER_CATALOG.find((p) => p.id === llmCfg.provider)?.endpoint || undefined;
                if (typeof args.apiKey === 'string' && args.apiKey.trim())
                    llmCfg.apiKey = args.apiKey.trim();
                saveConfig(fresh);
                llm = { ...llmCfg };
                syncActiveSessionLlm(llm);
                modelsCacheByKey.delete('');
                return { ok: true, provider: llmCfg.provider, model: llmCfg.model, endpoint: llmCfg.endpoint ?? null };
            },
            // Advanced settings editor: full `cli` block, shared with the terminal CLI.
            // This intentionally does NOT touch llm/providers/servers so write-only
            // secrets from those sections are not exposed through the JSON textarea.
            'action:set-cli-json': (args) => {
                const raw = typeof args.json === 'string' ? args.json : '{}';
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                }
                catch (err) {
                    throw new Error(`Invalid CLI JSON: ${err?.message ?? err}`);
                }
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    throw new Error('CLI config must be a JSON object.');
                const fresh = loadConfig();
                const next = parsed;
                // The renderer's view is scrubbed of secrets, so a whole-block save would
                // wipe the GitHub token. Carry it forward when the incoming JSON omits it.
                const prevTrack = fresh.cli?.track;
                const prevToken = prevTrack?.githubToken;
                const nextTrack = (next.track && typeof next.track === 'object' ? next.track : undefined);
                if (prevToken && (!nextTrack || nextTrack.githubToken === undefined)) {
                    next.track = { ...(nextTrack ?? {}), githubToken: prevToken };
                }
                const prevRepoTokens = new Map();
                for (const entry of prevTrack?.githubRepos ?? []) {
                    if (entry.repo && entry.token)
                        prevRepoTokens.set(entry.repo, entry.token);
                }
                if (prevRepoTokens.size) {
                    const targetTrack = ((next.track && typeof next.track === 'object') ? next.track : {});
                    if (Array.isArray(targetTrack.githubRepos)) {
                        targetTrack.githubRepos = targetTrack.githubRepos.map((entry) => {
                            const repo = typeof entry?.repo === 'string' ? entry.repo : '';
                            if (!repo || entry.token !== undefined)
                                return entry;
                            const token = prevRepoTokens.get(repo);
                            return token ? { ...entry, token } : entry;
                        });
                    }
                    else if (!nextTrack || nextTrack.githubRepos === undefined) {
                        targetTrack.githubRepos = prevTrack?.githubRepos;
                    }
                    next.track = targetTrack;
                }
                fresh.cli = next;
                saveConfig(fresh);
                _resetCliKnobsCache();
                return { ok: true };
            },
            // Settings → Connectors: persist the Track GitHub config. The token is
            // write-only (set when non-empty, kept otherwise) and never read back.
            'action:set-track-github': (args) => {
                const fresh = loadConfig();
                const cli = (fresh.cli = fresh.cli ?? {});
                const track = (cli.track = cli.track ?? {});
                if (typeof args.caBundle === 'string' || args.caBundle === null) {
                    const ca = typeof args.caBundle === 'string' ? args.caBundle.trim() : '';
                    if (ca)
                        track.githubCaBundle = ca;
                    else
                        delete track.githubCaBundle;
                    ghEnvCache = null;
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
                        if (typeof args.token === 'string' && args.token.trim())
                            nextEntry.token = args.token.trim();
                        if (args.clearToken === true) {
                            delete nextEntry.token;
                            if (track.githubRepo === repo || track.activeGithubRepo === repo)
                                delete track.githubToken;
                        }
                        if (idx >= 0)
                            repos[idx] = nextEntry;
                        else
                            repos.push(nextEntry);
                        if (args.makeActive === true || !track.activeGithubRepo)
                            track.activeGithubRepo = repo;
                    }
                }
                else if (args.clearToken === true) {
                    delete track.githubToken;
                }
                track.githubRepos = repos;
                syncLegacyTrackGithubFields(track);
                saveConfig(fresh);
                _resetCliKnobsCache();
                return { ok: true, ...githubIntegrationSnapshot(workspaceRoot) };
            },
            // §settings-completeness — set ONE cli.* knob (vs set-cli-json's whole-block
            // replace). `value: null` deletes the key (reverts to the default). Shared
            // with the CLI's config.json.
            // EXTENSIONS — enable/disable an extension (re-load to apply).
            'action:ext-set-enabled': async (args) => {
                const name = typeof args.name === 'string' ? args.name : '';
                if (!name)
                    return { ok: false, error: 'No extension name.' };
                setExtensionEnabled(name, args.enabled === true);
                await loadExtensions(workspaceRoot).catch(() => undefined);
                return { ok: true, name };
            },
            // EXTENSIONS — trust / untrust this workspace, then (re)load so workspace
            // extensions activate or deactivate immediately.
            'action:trust-workspace': async (args) => {
                if (args.trusted === true)
                    trustWorkspace(workspaceRoot);
                else
                    untrustWorkspace(workspaceRoot);
                await loadExtensions(workspaceRoot).catch(() => undefined);
                return { ok: true, trusted: isWorkspaceTrusted(workspaceRoot) };
            },
            'action:set-cli-knob': (args) => {
                const key = typeof args.key === 'string' ? args.key : '';
                if (!key)
                    return { ok: false, error: 'No knob key.' };
                const fresh = loadConfig();
                const cli = (fresh.cli = fresh.cli ?? {});
                if (args.value === null)
                    delete cli[key];
                else
                    cli[key] = args.value;
                saveConfig(fresh);
                _resetCliKnobsCache();
                return { ok: true, key };
            },
            // §multi-provider — add/update a NAMED OpenAI-compatible provider. A blank
            // apiKey on an UPDATE keeps the existing key (so the renderer never has to
            // echo it back). Returns the masked provider list.
            'action:set-provider': (args) => {
                const name = typeof args.name === 'string' ? args.name.trim() : '';
                if (!/^[a-zA-Z0-9._-]+$/.test(name))
                    return { ok: false, error: 'Provider name must be letters, digits, . _ - only.' };
                const fresh = loadConfig();
                const existing = fresh.providers?.[name];
                const providerId = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : (existing?.provider ?? 'openai');
                // §multi-select-models — the renderer sends the checked allowlist. Three
                // cases on EDIT: omitted (undefined) keeps the existing allowlist; an
                // explicit array (incl. []) replaces it; [] clears it. normalizeProviderModels
                // then enforces the invariant "default model ∈ models" (self-healing to
                // models[0]) so the single default and the allowlist can never disagree.
                const rawModels = Array.isArray(args.models)
                    ? args.models.filter((m) => typeof m === 'string')
                    : undefined;
                const allowlist = rawModels !== undefined ? rawModels : existing?.models;
                const rawModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : (existing?.model ?? '');
                const { model, models } = normalizeProviderModels(rawModel, allowlist);
                // Optional Azure-style api-version: explicit string sets/keeps it, '' clears,
                // omitted (undefined) preserves the existing value.
                const apiVersion = typeof args.apiVersion === 'string' ? args.apiVersion.trim() : existing?.apiVersion;
                const llmCfg = {
                    provider: providerId,
                    apiKey: typeof args.apiKey === 'string' && args.apiKey.trim() ? args.apiKey.trim() : (existing?.apiKey ?? ''),
                    model,
                    endpoint: typeof args.endpoint === 'string' ? (args.endpoint.trim() || PROVIDER_CATALOG.find((p) => p.id === providerId)?.endpoint || undefined) : (existing?.endpoint ?? PROVIDER_CATALOG.find((p) => p.id === providerId)?.endpoint),
                    ...(models ? { models } : {}),
                    ...(apiVersion ? { apiVersion } : {}),
                };
                if (!llmCfg.model)
                    return { ok: false, error: 'A model is required.' };
                saveConfig(setProvider(fresh, name, llmCfg));
                return { ok: true, name };
            },
            'action:remove-provider': (args) => {
                const name = typeof args.name === 'string' ? args.name.trim() : '';
                if (!name)
                    return { ok: false, error: 'No provider name.' };
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
                if (!p)
                    return { ok: false, error: `Unknown provider "${name}".` };
                fresh.llm = { provider: p.provider, apiKey: p.apiKey, model: p.model, endpoint: p.endpoint };
                const fallback = fresh.agentModels?.default;
                const fallbackDuplicatesMain = !!fallback &&
                    ((fallback.provider === name && (!fallback.model || fallback.model === p.model)) ||
                        (!fallback.provider && (!fallback.model || fallback.model === p.model)));
                if (fallbackDuplicatesMain)
                    fresh = setAgentModel(fresh, 'default', {});
                saveConfig(fresh);
                llm = fresh.llm ?? llm;
                syncActiveSessionLlm(llm);
                modelsCacheByKey.delete('');
                return { ok: true, provider: p.provider, model: p.model, endpoint: p.endpoint ?? null };
            },
            // §multi-provider — route a sub-agent ROLE to a provider/model. Blank
            // provider+model CLEARS the role (inherits the main model).
            'action:set-agent-model': (args) => {
                const role = typeof args.role === 'string' ? args.role.trim() : '';
                if (!role)
                    return { ok: false, error: 'No role.' };
                const provider = typeof args.provider === 'string' ? args.provider.trim() : '';
                const model = typeof args.model === 'string' ? args.model.trim() : '';
                const fresh = loadConfig();
                const defaultProviderName = matchingDefaultProvider(fresh.providers, fresh.llm).name ?? undefined;
                const providerCfg = provider ? fresh.providers?.[provider] : undefined;
                const duplicatesMain = (!provider && (!model || model === fresh.llm?.model)) ||
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
            'list-models': async (a) => {
                const fresh = loadConfig();
                llm = fresh.llm ?? llm;
                const provName = typeof a?.provider === 'string' && a.provider ? a.provider : undefined;
                const prov = provName ? (fresh.providers ?? {})[provName] : undefined;
                // A named provider that isn't configured yet → nothing to list.
                if (provName && !prov)
                    return { models: [], current: '', provider: provName };
                const activeLlm = prov ? undefined : syncActiveSessionLlm(llm);
                const l = prov ?? activeLlm ?? llm;
                const cacheKey = provName ?? '';
                const now = Date.now();
                const cached = modelsCacheByKey.get(cacheKey);
                const current = prov ? (prov.model ?? '') : (activeAgent.getModel?.() ?? l.model);
                if (cached && now - cached.at < 60_000)
                    return { models: cached.models, current, provider: provName };
                // Public/anonymous tier (opencode "public") — list free models with no key.
                const fallbackKey = PROVIDER_CATALOG.find((p) => p.id === (l.provider ?? '').toLowerCase())?.defaultApiKey ?? '';
                const { models } = await fetchEndpointModels(l.endpoint, (l.apiKey && l.apiKey.trim()) ? l.apiKey : fallbackKey, l.apiVersion);
                if (models.length)
                    modelsCacheByKey.set(cacheKey, { models, at: now });
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
                const id = `t${++termSeq}`;
                const isWin = process.platform === 'win32';
                const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
                const args = isWin ? ['-NoLogo'] : ['-i'];
                const proc = spawn(shell, args, {
                    cwd: workspaceRoot,
                    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
                });
                const sess = { proc, buf: '', alive: true };
                const append = (d) => {
                    sess.buf += d.toString('utf-8');
                    if (sess.buf.length > TERM_BUF_CAP)
                        sess.buf = sess.buf.slice(-TERM_BUF_CAP);
                };
                proc.stdout.on('data', append);
                proc.stderr.on('data', append);
                proc.on('exit', (code) => { sess.alive = false; sess.buf += `\r\n[shell exited ${code ?? '?'}]\r\n`; });
                terms.set(id, sess);
                return { id, shell };
            },
            'term-write': (args) => {
                const sess = terms.get(String(args.id));
                if (!sess?.alive)
                    return { ok: false };
                sess.proc.stdin.write(String(args.data ?? ''));
                return { ok: true };
            },
            'term-read': (args) => {
                const sess = terms.get(String(args.id));
                if (!sess)
                    return { chunk: '', next: 0, alive: false };
                const from = Math.max(0, Math.min(Number(args.from) || 0, sess.buf.length));
                return { chunk: sess.buf.slice(from), next: sess.buf.length, alive: sess.alive };
            },
            'term-kill': (args) => {
                const sess = terms.get(String(args.id));
                if (sess) {
                    try {
                        sess.proc.kill();
                    }
                    catch { /* already gone */ }
                    terms.delete(String(args.id));
                }
                return { ok: true };
            },
            // WS2 2.4 / WS6 6.3 — stop a background shell (e.g. a dev server an agent
            // started) from the Background-tasks panel. Kills the whole process group.
            'action:kill-bgshell': (args) => ({ ok: killBackgroundShell(String(args.id ?? '')) }),
            // Actions — host-side mutations the Settings dialog / palette trigger.
            // They ride the query channel (free-form names, result routing by id).
            'action:clear': () => { activeAgent.clearHistory(); return { ok: true }; },
            // WS8 — rewind the conversation to the message at (epoch) `ts`. Blocked when
            // code was generated after that point (rewindTranscript → canRewindTo); the
            // renderer surfaces the reason as an in-app warning. On success the
            // transcript is truncated and the agent's history reloaded from that point.
            'action:rewind-to': (args) => {
                const ts = typeof args.ts === 'number' ? args.ts : NaN;
                if (!Number.isFinite(ts))
                    return { ok: false, reason: 'Invalid rewind point.' };
                const entries = loadTranscript(workspaceRoot, activeAgent.sessionKey);
                let index = -1;
                for (let i = 0; i < entries.length; i++) {
                    const et = Date.parse(entries[i].timestamp);
                    if (Number.isFinite(et) && et <= ts)
                        index = i;
                }
                if (index < 0)
                    return { ok: false, reason: 'Could not find that point in the transcript.' };
                const r = rewindTranscript(workspaceRoot, activeAgent.sessionKey, index);
                if (!r.ok)
                    return { ok: false, reason: r.reason };
                activeAgent.loadHistory(r.kept);
                return { ok: true, kept: r.kept.length };
            },
            'action:compact': async () => activeAgent.compactHistory(),
            'action:set-pref': (args) => {
                const key = typeof args.key === 'string' ? args.key : '';
                const SETTABLE = new Set(['delegationPolicy', 'autoChain', 'personality', 'tier', 'theme', 'quiet', 'memoriesEnabled', 'personaAnchorEnabled', 'experimental', 'rawScrollback', 'editorMode']);
                if (!SETTABLE.has(key))
                    throw new Error(`Preference "${key}" is not settable from the desktop.`);
                return writePreferences(workspaceRoot, { [key]: args.value });
            },
            'action:set-session-mode': (args) => {
                const parsed = desktopSessionModePatchFromArgs(args);
                if (parsed.error)
                    throw new Error(parsed.error);
                const sessionMode = setSessionMode(workspaceRoot, activeAgent.sessionKey, parsed.patch);
                const activeMode = resolveActiveMode(workspaceRoot, activeAgent.sessionKey);
                return { ok: true, sessionKey: activeAgent.sessionKey, sessionMode, activeMode };
            },
            'action:set-hook': (args) => {
                const id = typeof args.id === 'string' ? args.id : '';
                return { ok: setHookEnabled(workspaceRoot, id, args.enabled === true) };
            },
            'action:set-access': (args) => {
                const mode = args.mode;
                if (mode !== 'read' && mode !== 'write' && mode !== 'shell')
                    throw new Error(`Unknown access mode "${String(mode)}".`);
                activeAgent.setAccessMode(mode);
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
                if (!id)
                    return { ok: false, error: 'No server id.' };
                const fresh = loadConfig();
                fresh.activeServer = id;
                saveConfig(fresh);
                try {
                    await mcpClient.reconnectOne(id);
                }
                catch { /* offline brains surface in status */ }
                return { ok: true, activeServer: id };
            },
            // T6 — add an MCP server: write the profile to config.json (shared with the
            // CLI) and connect it now. type 'stdio' needs a command; 'http' needs a url.
            'action:add-mcp': async (args) => {
                const id = String(args.id ?? '').trim();
                const type = args.type === 'http' ? 'http' : 'stdio';
                if (!/^[A-Za-z0-9._-]+$/.test(id))
                    return { ok: false, error: 'Server id must be letters, digits, dash, underscore or dot.' };
                // Optional auth/headers/env (a "KEY=value\nKEY2=value2" string → record).
                const kvPairs = (raw) => {
                    const out = {};
                    if (raw && typeof raw === 'object')
                        return raw;
                    if (typeof raw === 'string')
                        for (const line of raw.split('\n')) {
                            const i = line.indexOf('=');
                            if (i > 0)
                                out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                        }
                    return out;
                };
                const apiKey = String(args.apiKey ?? '').trim();
                const headers = kvPairs(args.headers);
                const env = kvPairs(args.env);
                const cfg = type === 'http'
                    ? { type: 'http', url: String(args.url ?? '').trim(),
                        ...(apiKey ? { apiKey } : {}), ...(Object.keys(headers).length ? { headers } : {}) }
                    : { type: 'stdio', command: String(args.command ?? '').trim(), args: typeof args.args === 'string' ? args.args.trim().split(/\s+/).filter(Boolean) : [],
                        ...(Object.keys(env).length ? { env } : {}) };
                const required = cfg.type === 'http' ? cfg.url : cfg.command;
                if (!required)
                    return { ok: false, error: `A ${type} server needs a ${type === 'http' ? 'url' : 'command'}.` };
                const fresh = loadConfig();
                fresh.servers = fresh.servers ?? {};
                if (fresh.servers[id])
                    return { ok: false, error: `A server named "${id}" already exists.` };
                fresh.servers[id] = cfg;
                saveConfig(fresh);
                try {
                    await mcpClient.connectOne(id, cfg, loadConfig().llm ?? llm, 5_000);
                }
                catch { /* offline — config saved, connect on next boot */ }
                return { ok: true, id };
            },
            'action:remove-mcp': async (args) => {
                const id = String(args.id ?? '').trim();
                if (!id)
                    return { ok: false, error: 'No server id.' };
                try {
                    await mcpClient.disconnectOne(id);
                }
                catch { /* already gone */ }
                const fresh = loadConfig();
                if (fresh.servers && fresh.servers[id]) {
                    delete fresh.servers[id];
                    saveConfig(fresh);
                }
                return { ok: true, id };
            },
            // DESK-6m — per-chat context-menu actions (Pin / Mark completed / Rename /
            // Move to group / Archive / Delete / Fork / Open). All write the shared
            // CLI stores, so the terminal sees the same titles/pins/groups.
            'action:session-meta': (args) => {
                // WS-UX — optional `root` lets the sidebar edit a session in a NON-active
                // workspace (parked project) without switching to it. Defaults to active.
                const root = typeof args.root === 'string' && args.root ? args.root : workspaceRoot;
                const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
                if (!sessionKey)
                    throw new Error('session-meta: missing sessionKey');
                const patch = (args.patch ?? {});
                const meta = setSessionMeta(root, sessionKey, patch);
                return { ok: true, sessionKey, meta, groups: listSessionGroups(root) };
            },
            'action:session-delete': (args) => {
                const root = typeof args.root === 'string' && args.root ? args.root : workspaceRoot;
                const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
                if (!sessionKey)
                    throw new Error('session-delete: missing sessionKey');
                const removed = deleteSession(root, sessionKey);
                removeSessionMeta(root, sessionKey);
                return { ok: removed, sessionKey };
            },
            'action:session-fork': (args) => {
                const root = typeof args.root === 'string' && args.root ? args.root : workspaceRoot;
                const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : '';
                if (!sessionKey)
                    throw new Error('session-fork: missing sessionKey');
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
                const sh = (cmd) => new Promise((resolve) => exec(cmd, { cwd: root, timeout: 8_000 }, () => resolve()));
                const isWin = process.platform === 'win32', isMac = process.platform === 'darwin';
                // HOTFIX — cmd.exe does NOT strip single quotes, so an arg must be double-
                // quoted on Windows or the opener silently fails (PR/CI links never opened).
                const q = (s) => shellQuoteArg(s, isWin);
                // T6 — open an explicit URL (CI/check/run links). https-only so a malicious
                // gh payload can't smuggle a file:// or shell-ish scheme; shell-quoted.
                const url = typeof args.url === 'string' ? args.url : '';
                if (url) {
                    if (!/^https:\/\/[^\s'"]+$/.test(url))
                        return { ok: false, error: 'only https URLs are allowed' };
                    void sh(isMac ? `open ${q(url)}` : isWin ? `start "" ${q(url)}` : `xdg-open ${q(url)}`);
                    return { ok: true, url };
                }
                if (what === 'pr') {
                    void sh('gh pr view --web');
                    return { ok: true, what };
                }
                if (what === 'editor') {
                    void sh(`code ${q(root)} || cursor ${q(root)} || ${isMac ? `open ${q(root)}` : isWin ? `start "" ${q(root)}` : `xdg-open ${q(root)}`}`);
                    return { ok: true, what };
                }
                if (what === 'finder') {
                    void sh(isMac ? `open ${q(root)}` : isWin ? `explorer ${q(root)}` : `xdg-open ${q(root)}`);
                    return { ok: true, what };
                }
                if (what === 'terminal') {
                    void sh(isMac ? `open -a Terminal ${q(root)}` : isWin ? `start cmd /K cd /d ${q(root)}` : `x-terminal-emulator --working-directory=${q(root)} || gnome-terminal --working-directory=${q(root)}`);
                    return { ok: true, what };
                }
                return { ok: false, what };
            },
        },
        onShutdown: () => {
            clearInterval(connectorSchedulerTimer);
            clearTimeout(connectorSchedulerBootTimer);
            stopWorkspaceWatcher();
            void mcpClient.close?.();
            if (!transport?.keepAlive)
                process.exit(0);
        },
    });
    if (transport)
        transport.onMessage((m) => { void core.handle(m); });
    else if (port)
        port.on('message', (e) => {
            if (computerUseBridge?.handleMessage(e.data))
                return;
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
// The Electron utilityProcess runs this file as its entry → auto-boot. An
// embedding host (the mobile WS adapter) sets BRAINROUTER_HOST_EMBEDDED and calls
// main(transport) itself, so importing this module must NOT double-boot.
if (!process.env.BRAINROUTER_HOST_EMBEDDED) {
    main().catch((err) => {
        console.error('[brainrouter-desktop host] fatal:', err instanceof Error ? err.stack : err);
        process.exit(1);
    });
}
