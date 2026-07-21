import type { Command } from 'commander';
import chalk from 'chalk';
import { getCliKnobs, loadConfig, setCliKnobOverride, hydrateConfigDefaultsOnDisk } from '@kinqs/brainrouter-core/config';
import { resolveSessionLlmConfig } from '@kinqs/brainrouter-core/session';
import { McpClientPool } from '@kinqs/brainrouter-core/mcp';
import { VERSION } from '@kinqs/brainrouter-core/version';
import { loadExtensions } from '@kinqs/brainrouter-core/extension';
import { setKnownMcpServerIds } from '../cli/ink/text/toolFormat.js';
import { redactMcpErrorText, redactMcpHttpUrl, redactMcpHttpUrlsInText } from '../cli/mcpUrl.js';
import { Agent } from '@kinqs/brainrouter-core/agent';
import { cliPrompter } from '../cli/prompt/cliPrompt.js';
import { runChat } from '../cli/ink/runChat.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { runCliOnboardingSequence } from '../cli/commands/init/onboardingSequence.js';
import { refreshCliOrgConventionRepos } from './orgConvention.js';
import {
  allMcpConnectionsFailed,
  configWithRuntimeMcpState,
  createRuntimeMcpState,
  resolveEffectiveLlmConfig,
  resolveEffectiveMcpLaunch,
  type RuntimeLaunchPolicy,
} from './mcpStartup.js';

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

      // Both onboarding lifecycles finish (or workspace setup is explicitly
      // skipped) before config hydration, MCP connections, Agent
      // construction, and therefore before a session key can exist.
      let skipMcpForLaunch = false;
      try {
        const onboarding = await runCliOnboardingSequence({
          workspaceRoot: workspace.workspaceRoot,
          global: 'if-needed',
        });
        if (onboarding.status === 'global-aborted') {
          console.error(chalk.gray('Setup aborted before saving — exiting. Run `brainrouter` again any time to retry.'));
          process.exit(0);
        }
        skipMcpForLaunch = onboarding.skipMcpForLaunch;
        if (onboarding.workspace === 'failed') {
          console.error(chalk.yellow(
            `Workspace setup could not finish (${onboarding.workspaceError ?? 'unknown error'}). `
            + 'Your global provider/MCP setup was saved; continuing with workspace defaults. Run `/init` to retry.',
          ));
        }
      } catch (err: any) {
        console.error(chalk.red(`Onboarding failed: ${err?.message ?? err}`));
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

      const requestedProfile = options.profile as string | undefined;
      const launchPolicy: RuntimeLaunchPolicy = {
        requestedProfile,
        modelOverride: typeof options.model === 'string' ? options.model : undefined,
        strictMcp: options.strictMcp === true,
        skipMcpForLaunch,
        // Includes persisted/env state plus the launch-only --safe-mode override.
        safeMode: getCliKnobs().safeMode,
      };
      const mcpLaunch = await resolveEffectiveMcpLaunch({
        config,
        workspaceRoot: workspace.workspaceRoot,
        policy: launchPolicy,
      });
      if (mcpLaunch.remoteBrain) {
        const remote = mcpLaunch.remoteBrain;
        const failure = remote.health.error ?? `HTTP ${remote.health.status}`;
        if (remote.outcome === 'remote') {
          console.error(`[BrainRouter] remote brain: ${remote.serverId} → ${redactMcpHttpUrl(remote.url)} (cli.brainUrl)`);
        } else if (remote.outcome === 'remote-unreachable') {
          console.error(`[BrainRouter] remote brain ${redactMcpHttpUrl(remote.url)} unreachable (${redactMcpHttpUrlsInText(failure)}); no embedded fallback — connecting anyway, will retry in background.`);
        } else {
          console.error(`[BrainRouter] remote brain ${redactMcpHttpUrl(remote.url)} unreachable (${redactMcpHttpUrlsInText(failure)}); falling back to embedded brain "${remote.embeddedServerId}".`);
        }
      }
      if (mcpLaunch.status === 'missing-profile') {
        console.error(chalk.red(`Error: Profile "${mcpLaunch.requestedProfile}" not found in config.`));
        console.error(chalk.gray(
          mcpLaunch.availableIds.length > 0
            ? `Available profiles: ${mcpLaunch.availableIds.join(', ')}.`
            : 'No MCP profiles are configured. Run `/init config` or `/login` to add one.',
        ));
        process.exit(1);
      }
      if (mcpLaunch.status === 'strict-no-profiles') {
        console.error(chalk.red('Error: No MCP server profiles in config.'));
        console.error(chalk.gray('--strict-mcp requires a configured MCP profile. Run `/init config` or `/login` to add one.'));
        process.exit(1);
      }
      const targetIds = mcpLaunch.targetIds;
      if (mcpLaunch.intentionallySkipped) {
        const ignored = mcpLaunch.ignoredRequestedProfile
          ? `; ignoring --profile ${mcpLaunch.ignoredRequestedProfile}`
          : '';
        console.error(chalk.gray(`[BrainRouter] MCP skipped for this launch${ignored}. Local tools remain available.`));
      } else if (targetIds.length === 0) {
        console.error(chalk.gray('[BrainRouter] No MCP profiles configured — starting with local tools only.'));
      }
      if (mcpLaunch.safeModeSkippedIds?.length) {
        console.error(chalk.yellow(
          `[BrainRouter] safe mode — skipping custom MCP servers: ${mcpLaunch.safeModeSkippedIds.join(', ')}`,
        ));
      }

      // Keep launch-only remote transport/workspace state outside the durable
      // config object so a later /login, /logout, or /config save cannot commit it.
      const runtimeMcp = createRuntimeMcpState(mcpLaunch);
      const runtimeConfig = configWithRuntimeMcpState(config, runtimeMcp);
      const targetServers = mcpLaunch.targetServers;
      const llm = resolveEffectiveLlmConfig(config, launchPolicy);

      // Connect everyone concurrently — offline servers don't block.
      // "Connecting..." status lines intentionally dropped (see prior
      // comment); the banner's per-server row is the success signal.
      const mcpClient = new McpClientPool();
      const statuses = await mcpClient.connectAll(targetServers, llm, {
        timeoutMs: 5_000,
        preferredBrainrouterServerId: mcpLaunch.runtimeActiveBrainrouterServer,
      });
      mcpClient.startReconnectSupervisor(); // WS9 — auto-reconnect dropped MCP servers in the background
      // Register live server ids for Ink tool-name display so multi-word
      // server names (e.g. `my_server`) don't get mis-stripped by the
      // single-underscore prefix regex.
      setKnownMcpServerIds(mcpClient.getServerIds());
      const failures = statuses.filter((s) => s.status === 'failed');
      if (allMcpConnectionsFailed(statuses)) {
        // Every server failed — equivalent to the pre-0.3.7 "MCP
        // unreachable" path; same --strict-mcp semantics apply.
        const summary = failures
          .map((s) => `${s.serverId}: ${redactMcpErrorText(s.error ?? 'unknown error', runtimeConfig, s.serverId)}`)
          .join('\n  ');
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
        await runChat({
          agent,
          mcpClient,
          config,
          workspace,
          federation,
          launchPolicy,
          runtimeMcp,
          mcpIntentionallySkipped: mcpLaunch.intentionallySkipped,
        });
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        await federation?.stop();
      }
    });
}
