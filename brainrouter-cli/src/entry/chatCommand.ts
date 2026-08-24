/**
 * CLI chat-command bootstrap and ownership boundary. It resolves configuration
 * before attaching one exact session participant, and shutdown releases that
 * Agent, transport, and remote registration exactly once.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, setCliKnobOverride, hydrateConfigDefaultsOnDisk, resolveCliKnobs, type LLMConfig } from '@kinqs/brainrouter-core/config';
import { resolveSessionLlmConfig } from '@kinqs/brainrouter-core/session';
import { McpClientPool, selectMcpServerIds, applyBrainUrlOverride, probeBrainHealth, embeddedBrainId } from '@kinqs/brainrouter-core/mcp';
import { applyActiveLlmProfile, registerDeclarativeProviders } from '@kinqs/brainrouter-core/provider';
import { VERSION } from '@kinqs/brainrouter-core/version';
import { loadExtensions } from '@kinqs/brainrouter-core/extension';
import { setKnownMcpServerIds } from '../cli/ink/text/toolFormat.js';
import type { ServerConfig } from '@kinqs/brainrouter-core/config';
import { Agent } from '@kinqs/brainrouter-core/agent';
import { cliPrompter } from '../cli/prompt/cliPrompt.js';
import { cliInteractionPort } from '../cli/prompt/cliInteractionPort.js';
import { runChat } from '../cli/ink/runChat.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { DEFAULT_LLM } from './shared.js';
import { refreshCliOrgConventionRepos } from './orgConvention.js';
import { resolveCliLearnedTenant } from '../runtime/account/learnedTenant.js';
import { safeOnboardingError } from '../cli/commands/init/onboardingErrors.js';
import { runCliOnboardingSequence } from '../cli/commands/init/onboardingSequence.js';

export interface ChatMcpStartupDecision {
  allowed: boolean;
  localOnly: boolean;
  error?: string;
}

/** Resolve explicit strict/profile flags against setup-time MCP Skip. */
export function decideChatMcpStartup(input: {
  serverIds: string[];
  requestedProfile?: string;
  strictMcp: boolean;
  mcpSkipped: boolean;
}): ChatMcpStartupDecision {
  if (input.strictMcp && (input.mcpSkipped || input.serverIds.length === 0)) {
    return { allowed: false, localOnly: false, error: '--strict-mcp requires an MCP profile for this launch.' };
  }
  if (input.mcpSkipped) return { allowed: true, localOnly: true };
  if (input.requestedProfile && !input.serverIds.includes(input.requestedProfile)) {
    return { allowed: false, localOnly: false, error: `Profile "${input.requestedProfile}" not found in config.` };
  }
  return { allowed: true, localOnly: input.serverIds.length === 0 };
}

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
    .option('--safe-mode', 'Troubleshooting mode: skip memory briefing, skills, hooks, and custom MCP servers for this session.')
    .option('--fallback-model <name...>', 'Ordered fallback model(s) tried when the primary model is unavailable (repeatable / space-separated, up to 3).')
    .option('--continue', 'Resume the most recent session in this workspace')
    .option('--resume <sessionKey>', 'Resume a specific session (exact key or unique prefix)')
    .action(async (options) => {
      if (options.workspace) {
        setCliKnobOverride({ workspaceOverride: options.workspace });
      }
      if (options.safeMode) {
        // CC-CONFIG-A1 — enable safe mode for THIS launch without persisting.
        setCliKnobOverride({ safeMode: true });
      }
      if (options.fallbackModel) {
        // CC-CONFIG-A2 — override the ordered fallback chain for THIS launch.
        // `setCliKnobOverride` shallow-replaces the resolved `fallbackModels`, so
        // sanitize + cap here to match the resolver's contract.
        const raw: unknown[] = Array.isArray(options.fallbackModel) ? options.fallbackModel : [options.fallbackModel];
        const chain: string[] = [...new Set(raw.map((m) => String(m).trim()).filter((s) => s.length > 0))].slice(0, 3);
        if (chain.length > 0) setCliKnobOverride({ fallbackModels: chain });
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

      let startupOnboarding: Awaited<ReturnType<typeof runCliOnboardingSequence>>;
      try {
        startupOnboarding = await runCliOnboardingSequence({
          workspaceRoot: workspace.workspaceRoot,
          global: 'if-needed',
        });
        if (startupOnboarding.status === 'global-aborted') {
          console.error(chalk.gray('Global setup aborted before saving — exiting. Run `brainrouter` again any time to retry.'));
          process.exit(0);
        }
        if (startupOnboarding.workspace === 'failed') {
          const workspaceError = safeOnboardingError(startupOnboarding.workspaceError ?? 'unknown error');
          console.error(chalk.yellow(
            `Workspace setup could not finish (${workspaceError}). `
            + 'The session will continue; run `/init` to retry.\n',
          ));
        }
      } catch (err: any) {
        console.error(chalk.red(`Setup failed: ${safeOnboardingError(err)}`));
        process.exit(1);
      }

      // CONFIG-HYDRATE — self-fill config.json with any missing safe cli.* knobs so
      // every setting is visible + editable (and new knobs appear on the next launch).
      // Runs only at this deliberate interactive boot, not on every config read.
      const addedKnobs = hydrateConfigDefaultsOnDisk();
      const config = loadConfig();
      if (addedKnobs > 0) {
        console.error(`[BrainRouter] config.json updated — added ${addedKnobs} default setting${addedKnobs === 1 ? '' : 's'} you can now edit (run /debug-config to see them).`);
      }
      await refreshCliOrgConventionRepos(config);

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
      const mcpStartup = decideChatMcpStartup({
        serverIds: allServerIds,
        requestedProfile,
        strictMcp: options.strictMcp === true,
        mcpSkipped: startupOnboarding.mcpSkipped,
      });
      if (!mcpStartup.allowed) {
        console.error(chalk.red(`Error: ${mcpStartup.error}`));
        console.error(chalk.gray(`Available profiles: ${allServerIds.join(', ')}.`));
        process.exit(1);
      }
      let targetIds = mcpStartup.localOnly
        ? []
        : selectMcpServerIds(config.servers, config.activeServer, requestedProfile);

      // CC-CONFIG-A1 — SAFE MODE: connect ONLY the BrainRouter brain, dropping any
      // custom / third-party MCP servers so a misbehaving external server can't
      // break the troubleshooting session. Identity is the explicit `identity`
      // tag, else the `brainrouter`-prefixed profile-name heuristic.
      if (resolveCliKnobs(config).safeMode) {
        const brainOnly = targetIds.filter((id) => {
          const s = config.servers[id];
          return s?.identity === 'brainrouter' || id.toLowerCase().startsWith('brainrouter');
        });
        if (brainOnly.length > 0 && brainOnly.length < targetIds.length) {
          const dropped = targetIds.filter((id) => !brainOnly.includes(id));
          console.error(chalk.yellow(`[BrainRouter] safe mode — skipping custom MCP servers: ${dropped.join(', ')}`));
          targetIds = brainOnly;
        }
      }

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

      // MC-D3 — overlay the active named LLM profile (cli.activeLlmProfile →
      // cli.llmProfiles) onto the base llm config. Inert when unset; an
      // explicit --model and per-session runtime overrides still win.
      const bootKnobs = resolveCliKnobs(config);

      // ADR-047 D1 — register declarative providers (packaged starter set +
      // cli.customProviders) into the live registry so an OpenAI-compatible
      // vendor added as DATA routes a turn with no code module. Loud but not
      // fatal: a malformed entry prints its reason and boot continues on the
      // built-ins rather than refusing to start.
      try {
        registerDeclarativeProviders(bootKnobs.customProviders);
      } catch (err) {
        console.error(chalk.yellow(`⚠ ${err instanceof Error ? err.message : String(err)}`));
      }

      const llm: LLMConfig = applyActiveLlmProfile(bootKnobs, { ...(config.llm ?? DEFAULT_LLM) });

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
      if (statuses.length > 0 && failures.length === statuses.length) {
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
      const learnedIdentity = await resolveCliLearnedTenant({ mcpClient, servers: targetServers });
      if (learnedIdentity.warning) console.error(chalk.yellow(`[BrainRouter] ${learnedIdentity.warning}`));
      const agent = new Agent(mcpClient, llm, {
        workspaceRoot: workspace.workspaceRoot,
        launchCwd: workspace.launchCwd,
        prompter: cliPrompter,
        interactionPort: cliInteractionPort,
        learnedTenant: learnedIdentity.tenant,
        learningEnabled: learnedIdentity.enabled,
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
      // The logical Agent session owns both the always-on loopback listener
      // and optional Brain registration. Resume therefore reclaims pending
      // durable rows; per-incarnation registry/MCP ownership still prevents
      // two live hosts from silently sharing the same address.
      const { attachFederation, resolveFederationSessionKey } = await import(
        '../runtime/federation/federationRegistration.js'
      );
      const { admitPeerMessageForAgent, recoverApprovedPeerMessagesForAgent } = await import(
        '../runtime/federation/peerMessageAdmission.js'
      );
      const { getSessionMeta } = await import('@kinqs/brainrouter-core/session');
      const federationKey = resolveFederationSessionKey(agent.sessionKey);
      agent.setFederationSessionKey(federationKey);
      const sessionMeta = getSessionMeta(agent.workspaceRoot, agent.sessionKey);
      const federation = await attachFederation({
        mcpClient,
        sessionKey: federationKey,
        workspaceRoot: workspace.workspaceRoot,
        clientKind: 'brainrouter-cli',
        state: 'idle',
        title: sessionMeta.title,
        titleSource: sessionMeta.titleSource,
        onPeerMessage: (message, senderDetails) =>
          admitPeerMessageForAgent(agent, message, senderDetails),
        onInboxError: (error) => {
          console.error(chalk.yellow(`[BrainRouter] session inbox: ${error.message}`));
        },
        // Federation Stage 3: render incoming text messages as a banner
        // above the next prompt. The poller fires every 5 s; `text`-kind
        // is the only kind we surface in 0.4.0, other kinds stay in the
        // inbox for Stage 4 / multi-agent Phase 2 consumers.
        onInboxText: async (messages) => {
          const { renderIncomingMessages } = await import('../cli/view/incomingBanner.js');
          renderIncomingMessages(messages);
        },
        onReceipts: async (receipts) => {
          const { renderSenderReceipts } = await import('../cli/view/incomingBanner.js');
          renderSenderReceipts(receipts);
        },
      });
      recoverApprovedPeerMessagesForAgent(agent, federationKey);
      // Hard-kill safety net: Ctrl-C, SIGTERM, and `process.exit` paths
      // skip the `finally` below. Best-effort unregister on signal so a
      // mid-tool-call kill doesn't leave a ghost waiting for the brain's
      // 5-min sweeper. Errors are swallowed by `stop()` itself.
      let signalEnding = false;
      const onSignal = (signal: NodeJS.Signals) => {
        if (signal === 'SIGINT' && !signalEnding) {
          signalEnding = true;
          // Ink owns the normal Ctrl+C unmount. Start the same bounded drain
          // immediately; runChat's cleanup awaits the idempotent Promise.
          void agent.endSession();
          void federation?.stop();
          return;
        }
        if (signalEnding) {
          process.exit(signal === 'SIGTERM' ? 143 : 130);
        }
        signalEnding = true;
        void (async () => {
          try { await agent.endSession(); } catch { /* bounded learning is best effort */ }
          await federation?.stop();
          process.exit(signal === 'SIGTERM' ? 143 : 130);
        })();
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        await runChat({
          agent,
          mcpClient,
          config,
          workspace,
          federation,
          localOnlyLaunch: mcpStartup.localOnly,
        });
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        await federation?.stop();
      }
    });
}
