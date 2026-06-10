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
import { execFileSync } from 'node:child_process';
import { InteractionBroker } from '@kinqs/brainrouter-agent-protocol';
// Deep imports into the CLI's built runtime (no "exports" field = allowed).
// Extracting a proper @kinqs/brainrouter-agent package is tracked for 0.4.16.
import { Agent } from '@kinqs/brainrouter-cli/dist/agent/agent.js';
import { loadConfig, saveConfig } from '@kinqs/brainrouter-cli/dist/config/config.js';
import { McpClientPool } from '@kinqs/brainrouter-cli/dist/runtime/mcpPool.js';
import { listTranscripts, loadTranscript } from '@kinqs/brainrouter-cli/dist/state/sessionStore.js';
import { buildRecap } from '@kinqs/brainrouter-cli/dist/state/sessionRecap.js';
import { collectRunningTasks } from '@kinqs/brainrouter-cli/dist/runtime/backgroundTasks.js';
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
            'session-info': () => ({ sessionKey: agent.sessionKey, model: llm.model, workspaceRoot }),
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
