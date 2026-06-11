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
import { exec, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { Agent } from '@kinqs/brainrouter-cli/dist/agent/agent.js';
import { loadConfig, saveConfig } from '@kinqs/brainrouter-cli/dist/config/config.js';
import { McpClientPool } from '@kinqs/brainrouter-cli/dist/runtime/mcpPool.js';
import { listTranscripts, loadTranscript } from '@kinqs/brainrouter-cli/dist/state/sessionStore.js';
import { buildRecap } from '@kinqs/brainrouter-cli/dist/state/sessionRecap.js';
import { collectRunningTasks } from '@kinqs/brainrouter-cli/dist/runtime/backgroundTasks.js';
// DESK-4c — the command/settings surfaces reuse the CLI's own modules so the
// desktop never drifts from the terminal: same catalog, same preferences
// file, same hooks store, same transcript tooling.
import { SLASH_COMMANDS, HELP_CATEGORIES } from '@kinqs/brainrouter-cli/dist/cli/repl.js';
import { readPreferences, writePreferences } from '@kinqs/brainrouter-cli/dist/state/preferencesStore.js';
import { readHooks, setHookEnabled } from '@kinqs/brainrouter-cli/dist/state/hooksStore.js';
import { searchTranscript } from '@kinqs/brainrouter-cli/dist/state/transcriptSearch.js';
import { exportTranscriptMarkdown, exportTranscriptJson, exportFileName } from '@kinqs/brainrouter-cli/dist/state/transcriptExport.js';
import { listChapters } from '@kinqs/brainrouter-cli/dist/state/chapterMarks.js';
import { buildUsageBreakdown } from '@kinqs/brainrouter-cli/dist/runtime/usageBreakdown.js';
async function main() {
    const workspaceRoot = process.env.BRAINROUTER_DESKTOP_WORKSPACE || process.cwd();
    // utilityProcess gives us process.parentPort; plain `node host.js` (dev
    // smoke) falls back to a console sink so the bootstrap is runnable solo.
    const port = process.parentPort;
    const send = port
        ? (msg) => port.postMessage(msg)
        : (msg) => console.log(JSON.stringify(msg));
    // Identical boot recipe to `brainrouter chat` (index.ts): config → llm →
    // pool.connectAll(profiles) → Agent. Offline MCP does not block (same
    // semantics as the CLI's non-strict mode).
    const config = loadConfig();
    const llm = config.llm || { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
    const mcpClient = new McpClientPool();
    try {
        await mcpClient.connectAll(config.servers ?? {}, llm, { timeoutMs: 5_000 });
    }
    catch { /* offline-mode: local tools only, same as the CLI */ }
    // DESK-3 — the approval/choice port: agent asks become interaction-request
    // events; the renderer's dialogs answer them. Shares the hostCore broker so
    // interrupt/shutdown dismiss pending dialogs fail-closed.
    const broker = new InteractionBroker();
    let emitForPort = () => { };
    const agent = new Agent(mcpClient, llm, {
        workspaceRoot,
        launchCwd: workspaceRoot,
        interactionPort: createBrokerPort(broker, (e) => emitForPort(e)),
    });
    const core = createHostCore({
        agent,
        send: send,
        broker,
        loadTranscript: (key) => loadTranscript(workspaceRoot, key),
        persistModel: (model) => {
            // Both heads read this file — a model picked in the desktop settings is
            // the CLI's model on its next launch, and vice versa.
            const fresh = loadConfig();
            fresh.llm = { ...(fresh.llm ?? llm), model };
            saveConfig(fresh);
        },
        queries: {
            // Read-only surfaces — same pure modules the TUI commands use.
            'list-sessions': () => listTranscripts(workspaceRoot).slice(0, 50),
            'recap': (args) => {
                const key = typeof args.sessionKey === 'string' ? args.sessionKey : agent.sessionKey;
                return buildRecap({ entries: loadTranscript(workspaceRoot, key), sessionKey: key });
            },
            'fleet': () => collectRunningTasks(workspaceRoot),
            'session-info': () => ({ sessionKey: agent.sessionKey, model: llm.model, workspaceRoot, username: os.userInfo().username }),
            // DESK-4d — the home/greeting view: real numbers from the workspace's
            // persisted transcripts (sessions, messages, active days, streaks, and
            // a per-day activity map for the heatmap).
            'home-stats': () => {
                const transcripts = listTranscripts(workspaceRoot).slice(0, 200);
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
                    model: llm.model,
                    perDay: Object.fromEntries(perDay),
                };
            },
            // DESK-4c — workspace browsing panels.
            'list-files': () => {
                try {
                    const tracked = execFileSync('git', ['ls-files'], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000, maxBuffer: 8_000_000 });
                    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000, maxBuffer: 8_000_000 });
                    const all = (tracked + '\n' + untracked).split('\n').filter(Boolean).sort();
                    return { files: all.slice(0, 3000), truncated: all.length > 3000 };
                }
                catch {
                    return { files: [], truncated: false };
                }
            },
            'read-file': (args) => {
                const file = typeof args.path === 'string' ? args.path : '';
                const resolved = path.resolve(workspaceRoot, file);
                if (!file || !(resolved === path.resolve(workspaceRoot) || resolved.startsWith(path.resolve(workspaceRoot) + path.sep))) {
                    return { path: file, content: '', error: 'path escapes the workspace' };
                }
                try {
                    const content = fs.readFileSync(resolved, 'utf-8');
                    return { path: file, content: content.slice(0, 200_000), truncated: content.length > 200_000 };
                }
                catch (err) {
                    return { path: file, content: '', error: err instanceof Error ? err.message : String(err) };
                }
            },
            'git-info': () => {
                try {
                    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000 }).trim();
                    let insertions = 0, deletions = 0, files = 0;
                    try {
                        const stat = execFileSync('git', ['diff', 'HEAD', '--shortstat'], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000 });
                        files = Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0);
                        insertions = Number(/(\d+) insertions?/.exec(stat)?.[1] ?? 0);
                        deletions = Number(/(\d+) deletions?/.exec(stat)?.[1] ?? 0);
                    }
                    catch { /* clean tree */ }
                    return { repo: path.basename(workspaceRoot), branch, files, insertions, deletions };
                }
                catch {
                    return { repo: path.basename(workspaceRoot), branch: null, files: 0, insertions: 0, deletions: 0 };
                }
            },
            // DESK-4 — diff/review surfaces. git-backed, tolerant of non-repos.
            'changed-files': () => {
                try {
                    const out = execFileSync('git', ['status', '--porcelain'], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000 });
                    return out.split('\n').filter(Boolean).slice(0, 200).map((line) => ({
                        status: line.slice(0, 2).trim() || '??',
                        path: line.slice(3).trim(),
                    }));
                }
                catch {
                    return [];
                }
            },
            'file-diff': (args) => {
                const file = typeof args.path === 'string' ? args.path : '';
                if (!file)
                    return { path: file, diff: '' };
                try {
                    // HEAD diff covers staged + unstaged; untracked files get a synthetic add-diff.
                    let diff = execFileSync('git', ['diff', 'HEAD', '--', file], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000, maxBuffer: 4_000_000 });
                    if (!diff.trim()) {
                        diff = execFileSync('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5_000, maxBuffer: 4_000_000 }).toString();
                    }
                    return { path: file, diff: diff.slice(0, 200_000) };
                }
                catch (err) {
                    // git diff --no-index exits 1 when files differ — its stdout IS the diff.
                    const out = err.stdout;
                    if (typeof out === 'string' && out.trim())
                        return { path: file, diff: out.slice(0, 200_000) };
                    return { path: file, diff: '' };
                }
            },
            // DESK-4c — every CLI slash command, straight from the CLI's catalog.
            'commands-catalog': () => ({ categories: HELP_CATEGORIES, all: [...SLASH_COMMANDS] }),
            // DESK-4c — one snapshot powering the whole Settings dialog. All values
            // come from the stores the CLI itself reads/writes.
            'config-snapshot': () => {
                const fresh = loadConfig();
                const cli = fresh.cli;
                return {
                    model: fresh.llm?.model ?? llm.model,
                    provider: fresh.llm?.provider ?? llm.provider,
                    fallbackModel: cli?.fallbackModel ?? null,
                    workspaceRoot,
                    sandbox: cli?.sandbox ?? 'off',
                    prefs: readPreferences(workspaceRoot),
                    permissionRules: { allow: cli?.permissions?.allow ?? [], deny: cli?.permissions?.deny ?? [] },
                    hooks: readHooks(workspaceRoot),
                    servers: mcpClient.getStatuses().map((s) => ({ id: s.serverId, online: s.status === 'connected', detail: s.identity !== 'unknown' ? s.identity : undefined })),
                };
            },
            'usage-breakdown': () => buildUsageBreakdown({ parent: agent.sessionUsage, children: [], offload: undefined }),
            'search-transcript': (args) => {
                const query = typeof args.q === 'string' ? args.q : '';
                return searchTranscript(loadTranscript(workspaceRoot, agent.sessionKey), query, { limit: 50 })
                    .map((m) => ({ index: m.index ?? 0, role: m.role ?? '?', snippet: m.snippet ?? '' }));
            },
            'chapters': () => listChapters(loadTranscript(workspaceRoot, agent.sessionKey)),
            'export-chat': (args) => {
                const format = args.format === 'json' ? 'json' : 'md';
                const entries = loadTranscript(workspaceRoot, agent.sessionKey);
                const exportedAt = new Date().toISOString();
                const meta = { sessionKey: agent.sessionKey, exportedAt };
                return {
                    filename: exportFileName(agent.sessionKey, format, exportedAt),
                    content: format === 'json' ? exportTranscriptJson(entries, meta) : exportTranscriptMarkdown(entries, meta),
                };
            },
            // DESK-4e — content search (the Files panel's "?text" mode, observed).
            'search-content': (args) => {
                const query = typeof args.q === 'string' ? args.q : '';
                if (!query.trim())
                    return [];
                try {
                    const out = execFileSync('git', ['grep', '-n', '-I', '--max-count', '3', '--', query], { cwd: workspaceRoot, encoding: 'utf-8', timeout: 8_000, maxBuffer: 4_000_000 });
                    return out.split('\n').filter(Boolean).slice(0, 50).map((line) => {
                        const [file, ln, ...rest] = line.split(':');
                        return { file, line: Number(ln) || 0, snippet: rest.join(':').trim().slice(0, 160) };
                    });
                }
                catch {
                    return [];
                }
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
            // DESK-4e — user-typed terminal commands (the Terminal panel's input
            // row). Equivalent to the CLI's `!` shell escape: the USER runs it, so
            // no approval gate; cwd is the workspace.
            'action:term-exec': (args) => {
                const cmd = typeof args.cmd === 'string' ? args.cmd : '';
                if (!cmd.trim())
                    return { out: '', code: 0 };
                return new Promise((resolve) => {
                    exec(cmd, { cwd: workspaceRoot, timeout: 20_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
                        resolve({
                            out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 20_000),
                            code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
                        });
                    });
                });
            },
            // Actions — host-side mutations the Settings dialog / palette trigger.
            // They ride the query channel (free-form names, result routing by id).
            'action:clear': () => { agent.clearHistory(); return { ok: true }; },
            'action:compact': async () => agent.compactHistory(),
            'action:set-pref': (args) => {
                const key = typeof args.key === 'string' ? args.key : '';
                const SETTABLE = new Set(['executionMode', 'reviewPolicy', 'delegationPolicy', 'autoChain', 'effort', 'personality', 'tier', 'theme', 'quiet', 'memoriesEnabled', 'personaAnchorEnabled', 'experimental', 'rawScrollback', 'editorMode']);
                if (!SETTABLE.has(key))
                    throw new Error(`Preference "${key}" is not settable from the desktop.`);
                return writePreferences(workspaceRoot, { [key]: args.value });
            },
            'action:set-hook': (args) => {
                const id = typeof args.id === 'string' ? args.id : '';
                return { ok: setHookEnabled(workspaceRoot, id, args.enabled === true) };
            },
            'action:set-access': (args) => {
                const mode = args.mode;
                if (mode !== 'read' && mode !== 'write' && mode !== 'shell')
                    throw new Error(`Unknown access mode "${String(mode)}".`);
                agent.setAccessMode(mode);
                return { ok: true, mode };
            },
            'action:reconnect-mcp': async (args) => {
                const id = typeof args.id === 'string' ? args.id : '';
                await mcpClient.reconnectOne(id);
                return { ok: true };
            },
        },
        onShutdown: () => { void mcpClient.close?.(); process.exit(0); },
    });
    // Route the port's interaction-request emissions through a dedicated
    // envelope stream (same wire, own seq namespace is unnecessary — reuse send).
    let seq = 1_000_000; // offset so port events never collide with core seq
    emitForPort = (e) => send({ seq: ++seq, ts: Date.now(), sessionKey: agent.sessionKey, event: e });
    if (port)
        port.on('message', (e) => { void core.handle(e.data); });
}
main().catch((err) => {
    console.error('[brainrouter-desktop host] fatal:', err instanceof Error ? err.stack : err);
    process.exit(1);
});
