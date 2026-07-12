/**
 * host/helpers — pure, closure-free helpers extracted verbatim from host.ts.
 *
 * These are the module-level (non-`main()`-scoped) functions and types the host
 * uses: config scrubbing, Track↔GitHub config normalization, the computer-use /
 * secret parent-port bridges, endpoint model probing, and transcript row
 * reconstruction. They depend only on top-level imports (no host runtime state),
 * so they live here BYTE-IDENTICAL and host.ts imports them back.
 */
import { exec, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import { LOCAL_PLACEHOLDER_KEY, withApiVersion, inferModelReasoningCapabilities, registerModelReasoningCapabilities, refreshLmStudioCache } from '@kinqs/brainrouter-core/provider';
import { listTranscripts } from '@kinqs/brainrouter-core/session';
import { getStateDir } from '@kinqs/brainrouter-core/storage';
import { readWorkspaceEntry } from '../fsRead.js';
import { resolveGithubConfigForWorkspace, listResolvedGithubConfigsForWorkspace } from '@kinqs/brainrouter-core/track';
import { isAnnotationStatus, isAnnotationTargetKind, isAnchorStale } from '@kinqs/brainrouter-types';
import { isArtifactKind, isArtifactStatus } from '@kinqs/brainrouter-types';
// `exec`/`spawn` are re-exported so host.ts keeps a single import site for the
// child-process primitives it still uses in its runtime section.
export { exec, execFile, spawn };
/**
 * Strip secrets from the `cli` config before it's sent to the renderer (the
 * snapshot's `cliKnobs` is shown verbatim in Settings → Advanced). The GitHub
 * token lives in `cli.track.githubToken` but must never cross to the renderer —
 * the desktop only ever learns whether one is *set*. Returns a shallow-cloned,
 * redacted copy; the on-disk config is untouched.
 */
export function scrubCliSecrets(cli) {
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
    // MC-B1 — the trigger-ingress signing secrets are write-only: the desktop's
    // Automations panel only ever learns whether each is *set* (via the snapshot's
    // triggerSecretsSet booleans), never the value. Strip them here so they can't
    // reach the renderer through cliKnobs.
    if (c.triggers && typeof c.triggers === 'object') {
        const triggers = { ...c.triggers };
        for (const k of ['githubSecret', 'slackSigningSecret', 'gitlabSecret', 'jiraSecret'])
            delete triggers[k];
        // Phase 1 — the GitHub App private key is write-only too: strip the inline
        // PEM before it reaches the renderer. The non-secret App fields (appId,
        // installationId, apiBase, privateKeyPath) stay so the panel can show the
        // App is configured without ever exposing the key.
        if (triggers.githubApp && typeof triggers.githubApp === 'object') {
            const app = { ...triggers.githubApp };
            delete app.privateKey;
            triggers.githubApp = app;
        }
        c.triggers = triggers;
    }
    if (c.router && typeof c.router === 'object') {
        const router = { ...c.router };
        delete router.serveKey;
        c.router = router;
    }
    return c;
}
export function normalizeTrackGithubRepos(track) {
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
export function syncLegacyTrackGithubFields(track) {
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
export function githubIntegrationSnapshot(workspaceRoot) {
    const cfg = resolveGithubConfigForWorkspace(workspaceRoot);
    const repos = listResolvedGithubConfigsForWorkspace(workspaceRoot).map((r) => ({ repo: r.repo, hasToken: r.hasToken, tokenSource: r.tokenSource ?? null, active: r.active, label: r.label, connectorId: r.connectorId, source: r.source }));
    const fresh = loadConfig();
    return { repo: cfg.repo ?? null, hasToken: !!cfg.token, tokenSource: cfg.tokenSource ?? null, repos, caBundle: fresh.cli?.track?.githubCaBundle ?? null, ...(cfg.error ? { error: cfg.error } : {}) };
}
export function createComputerUseBridge(port) {
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
/**
 * Connector Phase 2 — keychain secrets live in Electron MAIN (safeStorage is
 * unavailable in a utilityProcess), so the host requests values over the
 * parent port, mirroring the computer-use request/response bridge. Values
 * never travel further than this process — nothing secret reaches the renderer.
 */
export function createSecretBridge(port) {
    if (!port)
        return undefined;
    let seq = 0;
    const pending = new Map();
    return {
        get(key) {
            const id = `sec_${++seq}`;
            port.postMessage({ kind: 'secret-request', id, op: 'get', key });
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error('Secret lookup timed out waiting for Electron main.'));
                }, 10_000);
                pending.set(id, { resolve, reject, timer });
            });
        },
        handleMessage(message) {
            if (!message || typeof message !== 'object')
                return false;
            const msg = message;
            if (msg.kind !== 'secret-response' || typeof msg.id !== 'string')
                return false;
            const entry = pending.get(msg.id);
            if (!entry)
                return true;
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.ok)
                entry.resolve(msg.value);
            else
                entry.reject(new Error(msg.error || 'Secret lookup failed in Electron main.'));
            return true;
        },
    };
}
export const TERM_BUF_CAP = 400_000;
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
export async function fetchEndpointModels(endpoint, apiKey, apiVersion) {
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
export function endpointKey(endpoint) {
    return (endpoint ?? '').replace(/\/+$/, '');
}
export function matchingDefaultProvider(providers, llmCfg) {
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
export function lastTranscriptRole(filePath) {
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
export function entryTs(e) {
    if (typeof e.timestamp !== 'string')
        return undefined;
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) ? t : undefined;
}
/** Reconstruct user/assistant prose + tool-group rows from OpenAI-format entries. */
export function reconstructTranscriptRows(entries) {
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
export function annotateStale(workspaceRoot, rec) {
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
export function annotationFilterFromArgs(a) {
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
export function annotationAnchorFromArgs(raw) {
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
export function artifactFilterFromArgs(a) {
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
export function withSessionScope(filter, args, sessionKey) {
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
export function workerEventsToRows(entries) {
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
export function git(args, cwd, opts) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, encoding: 'utf-8', timeout: opts?.timeout ?? 5_000, maxBuffer: opts?.maxBuffer ?? 8_000_000 }, (_err, stdout) => resolve(String(stdout ?? '')));
    });
}
/** Sidebar row payload: transcript summary + the status the icons render. */
export function sessionRows(root, limit) {
    return listTranscripts(root, { limit }).map((s) => {
        const file = s.sessionDir
            ? path.join(s.sessionDir, s.fileName)
            : path.join(getStateDir(root), 'transcripts', s.fileName);
        return { ...s, lastRole: lastTranscriptRole(file) };
    });
}
