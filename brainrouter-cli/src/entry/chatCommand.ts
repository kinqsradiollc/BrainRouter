import fs from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, getConfigPath, setCliKnobOverride, hydrateConfigDefaultsOnDisk, resolveCliKnobs, type LLMConfig } from '@kinqs/brainrouter-core/config';
import { resolveSessionLlmConfig } from '@kinqs/brainrouter-core/session';
import { McpClientPool, selectMcpServerIds, applyBrainUrlOverride, probeBrainHealth, embeddedBrainId } from '@kinqs/brainrouter-core/mcp';
import { VERSION } from '@kinqs/brainrouter-core/version';
import { loadExtensions } from '@kinqs/brainrouter-core/extension';
import { setKnownMcpServerIds } from '../cli/ink/toolFormat.js';
import type { ServerConfig } from '@kinqs/brainrouter-core/config';
import { Agent } from '@kinqs/brainrouter-core/agent';
import { cliPrompter } from '../cli/prompt/cliPrompt.js';
import { runChat } from '../cli/ink/runChat.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { runWizard, isOnboarded } from '../cli/ink/runWizard.js';
import { DEFAULT_LLM } from './shared.js';

export function registerChatCommand(program: Command): void {
  // Chat Command (default)
  program
    .command('chat', { isDefault: true })
    .description('Start interactive agent REPL chat session (default)')
    .option('-p, --profile <name>', 'Connection profile name')
    .option('-m, --model <name>', 'LLM model override')
    .option('-w, --workspace <path>', 'Workspace root for files, commands, memory session, and MCP --root')
    .option('--strict-mcp', 'Exit if the MCP server is unreachable (default: continue in offline mode with local tools only)')
    .option('--quiet', 'Suppress recall tables, briefing dumps, and tool-completion previews (model prose only). Toggle in-session with /quiet.')
    .option('--continue', 'Resume the most recent session in this workspace')
    .option('--resume <sessionKey>', 'Resume a specific session (exact key or unique prefix)')
    .action(async (options) => {
      if (options.workspace) {
        setCliKnobOverride({ workspaceOverride: options.workspace });
      }
      if (options.quiet) {
        // Quiet mode is durable in preferences, but `--quiet` should turn it
        // on for THIS session without permanently flipping the user's saved
        // setting. Set an in-process knob override that the REPL checks.
        setCliKnobOverride({ quiet: true });
      }
      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);
      // Workspace path + detection reason intentionally NOT printed here — the
      // boxed startup banner shows the workspace row, and `/workspace` exposes
      // the launch CWD + detection reason on demand. Keeping a duplicate
      // stale-chrome line above the banner undermines the banner-first design.

      // 0.3.7 — first-run auto-trigger. When no config exists OR the
      // onboarded marker is missing, drop the user straight into the
      // wizard before constructing the Agent / MCP client. This replaces
      // the pre-0.3.7 "Error: No BrainRouter config found ... run
      // `brainrouter login`" exit-with-error path. The wizard owns its
      // own readline for the wizard's lifetime; when it returns we
      // continue into the REPL with the freshly-saved config.
      if (!fs.existsSync(getConfigPath()) || !isOnboarded()) {
        try {
          const wizardResult = await runWizard({
            workspaceRoot: workspace.workspaceRoot,
          });
          if (wizardResult.state.aborted) {
            console.error(chalk.gray('Wizard aborted before saving — exiting. Run `brainrouter` again any time to retry.'));
            process.exit(0);
          }
        } catch (err: any) {
          console.error(chalk.red(`Wizard failed: ${err?.message ?? err}`));
          process.exit(1);
        }
      }

      // CONFIG-HYDRATE — self-fill config.json with any missing safe cli.* knobs so
      // every setting is visible + editable (and new knobs appear on the next launch).
      // Runs only at this deliberate interactive boot, not on every config read.
      const addedKnobs = hydrateConfigDefaultsOnDisk();
      const config = loadConfig();
      if (addedKnobs > 0) {
        console.error(`[BrainRouter] config.json updated — added ${addedKnobs} default setting${addedKnobs === 1 ? '' : 's'} you can now edit (run /debug-config to see them).`);
      }

      // REMOTE-BRAIN (Workstream A) — if `cli.brainUrl` is set, point the active
      // brain at the remote HTTP endpoint (embedded/stdio stays default when unset).
      // Phase 2: probe the remote's /health first and gracefully fall back to a
      // configured embedded brain when it's unreachable, so a momentary remote
      // outage never strands a user who also has a local brain.
      const brainUrl = resolveCliKnobs(config).brainUrl;
      if (brainUrl) {
        const health = await probeBrainHealth(brainUrl, { timeoutMs: 3_000 });
        const embedded = embeddedBrainId(config.servers);
        if (health.ok || !embedded) {
          const overridden = applyBrainUrlOverride(config.servers, config.activeServer, brainUrl);
          config.servers = overridden.servers;
          config.activeServer = overridden.activeServer;
          if (health.ok) {
            console.error(`[BrainRouter] remote brain: ${config.activeServer} → ${brainUrl} (cli.brainUrl)`);
          } else {
            console.error(`[BrainRouter] remote brain ${brainUrl} unreachable (${health.error ?? `HTTP ${health.status}`}); no embedded fallback — connecting anyway, will retry in background.`);
          }
        } else {
          console.error(`[BrainRouter] remote brain ${brainUrl} unreachable (${health.error ?? `HTTP ${health.status}`}); falling back to embedded brain "${embedded}".`);
        }
      }

      // 0.3.7 — multi-MCP support. Third-party MCPs are additive and all
      // connect concurrently. BrainRouter MCPs are different: users may store
      // several BrainRouter profiles (local/staging/remote/self-hosted), but
      // only one brain should be active at a time. `activeServer` selects that
      // BrainRouter profile when it points at one; otherwise we use the first
      // configured BrainRouter profile. `--profile <name>` still scopes the run
      // to exactly one server for explicit single-server mode.
      const requestedProfile = options.profile as string | undefined;
      const allServerIds = Object.keys(config.servers);
      if (allServerIds.length === 0) {
        console.error(chalk.red('Error: No MCP server profiles in config.'));
        console.error(chalk.gray('Run `/login` inside the REPL or `brainrouter login` to add a profile.'));
        process.exit(1);
      }
      if (requestedProfile && !config.servers[requestedProfile]) {
        console.error(chalk.red(`Error: Profile "${requestedProfile}" not found in config.`));
        console.error(chalk.gray(`Available profiles: ${allServerIds.join(', ')}.`));
        process.exit(1);
      }
      const targetIds = selectMcpServerIds(config.servers, config.activeServer, requestedProfile);

      // Pre-process each target's serverConfig to thread workspaceRoot
      // into the stdio `--root` arg shape the MCP server expects.
      const targetServers: Record<string, ServerConfig> = {};
      for (const id of targetIds) {
        const cloned = { ...config.servers[id] };
        if (cloned.type === 'stdio') {
          const args = cloned.args ?? [];
          const rootIndex = args.indexOf('--root');
          cloned.args = rootIndex >= 0
            ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
            : [...args, '--root', workspace.workspaceRoot];
        }
        targetServers[id] = cloned;
        config.servers[id] = cloned;
      }

      const llm: LLMConfig = { ...(config.llm ?? DEFAULT_LLM) };

      if (options.model) {
        llm.model = options.model;
      }

      // Connect everyone concurrently — offline servers don't block.
      // "Connecting..." status lines intentionally dropped (see prior
      // comment); the banner's per-server row is the success signal.
      const mcpClient = new McpClientPool();
      const statuses = await mcpClient.connectAll(targetServers, llm, { timeoutMs: 5_000 });
      mcpClient.startReconnectSupervisor(); // WS9 — auto-reconnect dropped MCP servers in the background
      // Register live server ids for Ink tool-name display so multi-word
      // server names (e.g. `my_server`) don't get mis-stripped by the
      // single-underscore prefix regex.
      setKnownMcpServerIds(mcpClient.getServerIds());
      const failures = statuses.filter((s) => s.status === 'failed');
      if (failures.length === statuses.length) {
        // Every server failed — equivalent to the pre-0.3.7 "MCP
        // unreachable" path; same --strict-mcp semantics apply.
        const summary = failures.map((s) => `${s.serverId}: ${s.error ?? 'unknown error'}`).join('\n  ');
        console.error(chalk.red(`Failed to connect to any MCP server:\n  ${summary}`));
        if (options.strictMcp) {
          console.error(chalk.gray('--strict-mcp set; exiting.'));
          process.exit(1);
        }
        // Falls through to offline-mode REPL — banner shows the warning.
      } else if (failures.length > 0) {
        // Partial failure — surface the failing server names without
        // exiting; user can /mcp reconnect <id> later.
        const failed = failures.map((s) => s.serverId).join(', ');
        console.error(chalk.yellow(`⚠ ${failures.length} of ${statuses.length} MCP servers offline: ${failed}. Other servers connected; use /mcp to inspect.`));
      }

      // EXTENSIONS — discover + activate code-level extensions (tools/providers/
      // hooks) before the first turn. Workspace-tier extensions only load in a
      // trusted workspace; best-effort, never blocks boot.
      await loadExtensions(workspace.workspaceRoot, { version: VERSION }).catch(() => undefined);
      const agent = new Agent(mcpClient, llm, {
        workspaceRoot: workspace.workspaceRoot,
        launchCwd: workspace.launchCwd,
        prompter: cliPrompter,
      });
      // CC-P2.1 — `--continue` / `--resume <key>`: load a persisted session's
      // transcript into this launch before the REPL starts. Errors print and
      // fall through to a fresh session (never abort the launch).
      if (options.continue || options.resume) {
        const { listTranscripts, loadTranscript } = await import('@kinqs/brainrouter-core/session');
        const { pickResumeSession } = await import('../state/resumePicker.js');
        const pick = pickResumeSession(listTranscripts(workspace.workspaceRoot), {
          continueLatest: !!options.continue,
          resumeKey: typeof options.resume === 'string' ? options.resume : undefined,
        });
        if (pick.ok) {
          const entries = loadTranscript(workspace.workspaceRoot, pick.sessionKey);
          agent.sessionKey = pick.sessionKey;
          if (!options.model) agent.setLLMConfig(resolveSessionLlmConfig(llm, workspace.workspaceRoot, pick.sessionKey));
          agent.resetSessionCounters();
          const loaded = agent.loadHistory(entries);
          console.log(chalk.green(`Resumed session ${pick.sessionKey} (${loaded} prior messages).`));
        } else {
          console.log(chalk.yellow(pick.error + ' Starting a fresh session.'));
        }
      }
      // Federation Stage 2 (FED-S2-T2/T3): claim a row in the brain's
      // active_sessions registry + heartbeat every 30s. Resolves to null
      // (no-op) when the brain pre-dates Stage 2 — older brains keep
      // working unchanged. The federation sessionKey is per-workspace
      // and persisted (NOT the same as agent.sessionKey, which is the
      // chat session and rotates per-launch) so clean restarts refresh
      // the registry row instead of stacking ghosts.
      const { attachFederation, resolveFederationSessionKey } = await import(
        '../runtime/federation/federationRegistration.js'
      );
      const federationKey = resolveFederationSessionKey(workspace.workspaceRoot);
      agent.setFederationSessionKey(federationKey);
      const federation = await attachFederation({
        mcpClient,
        sessionKey: federationKey,
        workspaceRoot: workspace.workspaceRoot,
        clientKind: 'brainrouter-cli',
        // Federation Stage 3: render incoming text messages as a banner
        // above the next prompt. The poller fires every 5 s; `text`-kind
        // is the only kind we surface in 0.4.0, other kinds stay in the
        // inbox for Stage 4 / multi-agent Phase 2 consumers.
        onInboxText: async (messages) => {
          const { renderIncomingMessages } = await import('../cli/view/incomingBanner.js');
          renderIncomingMessages(messages);
        },
      });
      // Hard-kill safety net: Ctrl-C, SIGTERM, and `process.exit` paths
      // skip the `finally` below. Best-effort unregister on signal so a
      // mid-tool-call kill doesn't leave a ghost waiting for the brain's
      // 5-min sweeper. Errors are swallowed by `stop()` itself.
      const onSignal = () => { void federation?.stop(); };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        await runChat({ agent, mcpClient, config, workspace, federation });
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        await federation?.stop();
      }
    });
}
