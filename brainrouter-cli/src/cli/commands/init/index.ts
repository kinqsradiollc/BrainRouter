import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { initAgentMd } from '../../../prompt/initAgentMd.js';
import type { Config, LLMConfig } from '@kinqs/brainrouter-core/config';
import type { McpServerStatus } from '@kinqs/brainrouter-core/mcp';
import { isWorkspaceOnboarded } from '@kinqs/brainrouter-core/workspace';
import { setKnownMcpServerIds } from '../../ink/text/toolFormat.js';
import {
  allMcpConnectionsFailed,
  createRuntimeMcpState,
  resolveEffectiveLlmConfig,
  resolveEffectiveMcpLaunch,
  type RemoteBrainDecision,
  type RuntimeLaunchPolicy,
  type RuntimeMcpState,
} from '../../../entry/mcpStartup.js';
import {
  runProjectOnboarding,
  suggestWorkspaceProfile,
  type ProjectOnboardingOptions,
  type ProjectOnboardingResult,
} from './projectOnboard.js';
import {
  runCliOnboardingSequence,
  type CliOnboardingSequenceOptions,
  type CliOnboardingSequenceResult,
} from './onboardingSequence.js';

/**
 * `/init` slash command for global and workspace setup lifecycles.
 *
 * The CLI has TWO onboardings, and `/init` now fronts the PROJECT one:
 *
 *   - `/init` (bare) — PROJECT onboarding for the current workspace: detected
 *     profile suggestion, editable agents/capabilities/skills/tools, optional
 *     AGENT.md scaffold, final review, then one confirmed commit. In an
 *     already-onboarded workspace it prints the manifest summary instead.
 *   - `/init --edit` — reload the current manifest into the same review flow;
 *     safe unknown fields survive the round trip.
 *   - `/init config` — the GLOBAL provider/model/MCP wizard, followed by
 *     project setup only when global persistence completes successfully.
 *   - `/init scan` — print the detected profile suggestion + reasons only;
 *     never writes.
 *   - `/init agentmd` — back-compat alias for the 0.3.6 behaviour that only
 *     scaffolds AGENT.md.
 *   - `/init agent` — repository-assisted project setup. It is intentionally
 *     distinct from the one-shot instruction-file alias.
 */
export interface InitCommandDependencies {
  initInstructions(workspaceRoot: string): ReturnType<typeof initAgentMd>;
  suggestProfile: typeof suggestWorkspaceProfile;
  runProjectSetup(workspaceRoot: string, options?: ProjectOnboardingOptions): Promise<ProjectOnboardingResult>;
  runSequence(options: CliOnboardingSequenceOptions): Promise<CliOnboardingSequenceResult>;
  runAssistedSetup(ctx: CommandContext): Promise<void>;
}

const DEFAULT_DEPENDENCIES: InitCommandDependencies = {
  initInstructions: initAgentMd,
  suggestProfile: suggestWorkspaceProfile,
  runProjectSetup: runProjectOnboarding,
  runSequence: runCliOnboardingSequence,
  runAssistedSetup: async (ctx) => {
    console.log(chalk.gray('\nScanning repository signals before project setup…\n'));
    await runProjectOnboarding(ctx.agent.workspaceRoot, {
      edit: isWorkspaceOnboarded(ctx.agent.workspaceRoot),
    });
  },
};

/** Put the existing shared pool into local-only mode for the rest of this run. */
export async function disconnectMcpForLaunch(
  pool: CommandContext['mcpClient'],
): Promise<string[]> {
  pool.stopReconnectSupervisor();
  const serverIds = pool.getServerIds();
  // removeOne rebuilds the shared tool index, so serialize these removals
  // rather than racing multiple index refreshes against the same pool.
  for (const serverId of serverIds) {
    await pool.removeOne(serverId);
  }
  setKnownMcpServerIds([]);
  return serverIds;
}

/** Replace a shared config object's contents without invalidating its identity. */
export function synchronizeConfigInPlace(target: Config, committed: Config): void {
  const mutable = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    if (!Object.prototype.hasOwnProperty.call(committed, key)) delete mutable[key];
  }
  // A forward/hand-edited JSON config may contain an own `__proto__` key.
  // Object.assign would invoke the legacy setter and poison the long-lived
  // shared config object's prototype, so copy every field as data instead.
  Object.setPrototypeOf(mutable, Object.prototype);
  const cloned = structuredClone(committed) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(cloned)) {
    Object.defineProperty(mutable, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

export interface LiveMcpReconcileResult {
  targetIds: string[];
  statuses: McpServerStatus[];
  removedIds: string[];
  intentionallySkipped: boolean;
  safeModeSkippedIds?: string[];
  remoteBrain?: RemoteBrainDecision;
  runtimeMcp: RuntimeMcpState;
}

/** Reconcile the shared pool to the same profile set a fresh launch selects. */
export async function reconcileMcpAfterGlobalSetup(
  pool: CommandContext['mcpClient'],
  config: Config,
  workspaceRoot: string,
  policy: RuntimeLaunchPolicy = {},
  llmConfig: LLMConfig = resolveEffectiveLlmConfig(config, policy),
): Promise<LiveMcpReconcileResult> {
  // Provider selection is launch state too. Update it even when MCP is
  // intentionally skipped so later manual/background reconnects cannot revive
  // the pre-wizard provider snapshot.
  pool.setReconnectLlmConfig(llmConfig);
  const launch = await resolveEffectiveMcpLaunch({ config, workspaceRoot, policy });
  if (launch.status === 'missing-profile') {
    throw new Error(
      `Profile "${launch.requestedProfile}" is not present after global setup. Available profiles: `
      + `${launch.availableIds.join(', ') || 'none'}.`,
    );
  }
  if (launch.status === 'strict-no-profiles') {
    throw new Error('--strict-mcp requires a configured MCP profile after global setup.');
  }
  const runtimeMcp = createRuntimeMcpState(launch);
  if (launch.intentionallySkipped) {
    const removedIds = await disconnectMcpForLaunch(pool);
    return {
      targetIds: [],
      statuses: [],
      removedIds,
      intentionallySkipped: true,
      runtimeMcp,
      ...(launch.remoteBrain ? { remoteBrain: launch.remoteBrain } : {}),
    };
  }

  const targetSet = new Set(launch.targetIds);
  const removedIds: string[] = [];
  // Pause retries while the desired set changes. Unlike launch-only Skip, a
  // normal reconfiguration always re-arms the supervisor in finally.
  pool.stopReconnectSupervisor();
  try {
    for (const serverId of pool.getServerIds()) {
      if (!targetSet.has(serverId)) {
        await pool.removeOne(serverId);
        removedIds.push(serverId);
      }
    }
    const statuses = await pool.connectAll(launch.targetServers, llmConfig, {
      timeoutMs: 5_000,
      preferredBrainrouterServerId: launch.runtimeActiveBrainrouterServer,
    });
    if (policy.strictMcp && allMcpConnectionsFailed(statuses)) {
      throw new Error('--strict-mcp is active and every selected MCP profile failed to connect.');
    }
    return {
      targetIds: launch.targetIds,
      statuses,
      removedIds,
      intentionallySkipped: false,
      runtimeMcp,
      ...(launch.safeModeSkippedIds ? { safeModeSkippedIds: launch.safeModeSkippedIds } : {}),
      ...(launch.remoteBrain ? { remoteBrain: launch.remoteBrain } : {}),
    };
  } finally {
    setKnownMcpServerIds(pool.getServerIds());
    pool.startReconnectSupervisor();
  }
}

export async function tryHandleInitCommand(
  ctx: CommandContext,
  overrides: Partial<InitCommandDependencies> = {},
): Promise<boolean> {
  const { command, args, agent, repl } = ctx;
  if (command !== '/init') return false;
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const sub = args[0]?.toLowerCase();

  // Back-compat: explicit subcommand keeps the 0.3.6 one-shot behaviour.
  if (sub === 'agentmd') {
    const result = dependencies.initInstructions(agent.workspaceRoot);
    if (result.status === 'created') {
      console.log(chalk.green(`\n✓ Created ${result.path}`));
      console.log(chalk.gray('  Edit it to describe your project — any AGENT.md-aware agent will read it.\n'));
    } else {
      console.log(chalk.yellow(`\nFile already exists: ${result.path}`));
      console.log(chalk.gray('  Existing project instructions were left unchanged.\n'));
    }
    return true;
  }

  if (sub === 'agent') {
    try {
      await dependencies.runAssistedSetup(ctx);
    } catch (err: any) {
      console.error(chalk.red(`\n/init agent failed: ${err?.message ?? err}\n`));
    }
    return true;
  }

  // Read-only profile detection — show what bare `/init` would suggest.
  if (sub === 'scan') {
    const suggestion = dependencies.suggestProfile(agent.workspaceRoot);
    console.log(`\n${chalk.bold('Detected profile')}: ${suggestion.profile}`);
    console.log(chalk.gray(`  ${suggestion.reasons.join('; ')}`));
    console.log(chalk.gray('  Run `/init` to onboard this workspace with it.\n'));
    return true;
  }

  // GLOBAL setup always completes before the project flow is considered.
  if (sub === 'config' || sub === 'setup') {
    try {
      const result = await dependencies.runSequence({
        workspaceRoot: agent.workspaceRoot,
        global: 'always',
      });
      if (result.status === 'global-aborted') {
        console.log(chalk.gray('\nGlobal setup cancelled — workspace setup was not started.\n'));
        return true;
      }
      if (result.config) {
        // Keep the shared object identity held by the REPL/banner/footer while
        // applying every committed field, including provider credentials and
        // optional settings removed by the wizard's normalized snapshot.
        synchronizeConfigInPlace(ctx.config, result.config);
        ctx.repl.launchPolicy.skipMcpForLaunch = result.skipMcpForLaunch;
        const effectiveLlm = resolveEffectiveLlmConfig(ctx.config, ctx.repl.launchPolicy);
        agent.replaceLLMConfig(effectiveLlm);
      }
      if (result.config) {
        try {
          const effectiveLlm = resolveEffectiveLlmConfig(ctx.config, ctx.repl.launchPolicy);
          const live = await reconcileMcpAfterGlobalSetup(
            ctx.mcpClient,
            ctx.config,
            agent.workspaceRoot,
            ctx.repl.launchPolicy,
            effectiveLlm,
          );
          ctx.repl.runtimeMcp = live.runtimeMcp;
          if (live.intentionallySkipped) {
            console.log(chalk.gray(
              live.removedIds.length > 0
                ? `  MCP skipped for this launch; disconnected ${live.removedIds.join(', ')}. Saved profiles were kept for next launch.\n`
                : '  MCP skipped for this launch; local tools remain available.\n',
            ));
          } else if (live.safeModeSkippedIds?.length) {
            console.log(chalk.yellow(
              `  Safe mode kept BrainRouter only; skipped ${live.safeModeSkippedIds.join(', ')}.\n`,
            ));
          }
          const failed = live.statuses.filter((status) => status.status === 'failed');
          if (!live.intentionallySkipped && failed.length > 0) {
            console.log(chalk.yellow(
              `  Saved MCP setup; ${failed.map((status) => status.serverId).join(', ')} is offline and will retry in the background.\n`,
            ));
          }
        } catch (err: any) {
          console.error(chalk.yellow(
            `  Global setup was saved, but the live MCP refresh failed (${err?.message ?? err}). `
            + 'The reconnect supervisor remains active; use `/mcp` to inspect status.\n',
          ));
        }
      }
      if (result.workspace === 'failed') {
        console.error(chalk.yellow(
          `  Workspace setup could not finish (${result.workspaceError ?? 'unknown error'}). `
          + 'Global setup is active; run `/init` to retry the project step.\n',
        ));
      }
      repl.refreshPromptForMode();
    } catch (err: any) {
      console.error(chalk.red(`\n/init config failed: ${err?.message ?? err}\n`));
    }
    return true;
  }

  if (sub === '--edit' || sub === 'edit') {
    try {
      await dependencies.runProjectSetup(agent.workspaceRoot, { edit: true });
    } catch (err: any) {
      console.error(chalk.red(`\n/init --edit failed: ${err?.message ?? err}\n`));
    }
    return true;
  }

  if (sub !== undefined) {
    console.error(chalk.red(`\nUnknown /init option: ${args[0]}`));
    console.log(chalk.gray('  Usage: /init [--edit|scan|agent|agentmd|config]\n'));
    return true;
  }

  // Bare `/init` — PROJECT onboarding (summary only when already onboarded).
  try {
    await dependencies.runProjectSetup(agent.workspaceRoot);
    console.log(chalk.gray('  Edit workspace: `/init --edit` · global setup: `/init config` · instructions only: `/init agentmd`\n'));
  } catch (err: any) {
    console.error(chalk.red(`\n/init failed: ${err?.message ?? err}\n`));
  }
  return true;
}
