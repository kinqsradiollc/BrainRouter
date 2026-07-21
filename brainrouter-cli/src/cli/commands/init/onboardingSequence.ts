/**
 * Ordered coordination for the CLI's two onboarding lifecycles.
 *
 * Global provider/model setup always precedes per-workspace setup. This module
 * is intentionally dependency-injected so startup ordering can be tested
 * without mounting Ink or touching the real user config. Project cancellation
 * does not roll back completed global setup and does not prevent a session;
 * aborting global setup does.
 */
import { getConfigPath, type Config } from '@kinqs/brainrouter-core/config';
import { isWorkspaceOnboarded } from '@kinqs/brainrouter-core/workspace';
import { isOnboarded, runWizard } from '../../ink/wizard/runWizard.js';
import {
  isRegularFileNoFollow,
  recoverGlobalSetupState,
} from '../../wizard/globalPersistence.js';
import { runProjectOnboarding, type ProjectOnboardingResult } from './projectOnboard.js';

export interface GlobalOnboardingResult {
  state: { committed: boolean; aborted: boolean };
  config?: Config;
  skipMcpForLaunch?: boolean;
}

export interface CliOnboardingDependencies {
  recoverGlobalSetup(): void;
  hasGlobalSetup(): boolean;
  hasWorkspaceSetup(workspaceRoot: string): boolean;
  runGlobalSetup(workspaceRoot: string): Promise<GlobalOnboardingResult>;
  runWorkspaceSetup(workspaceRoot: string): Promise<ProjectOnboardingResult>;
}

export interface CliOnboardingSequenceOptions {
  workspaceRoot: string;
  global: 'if-needed' | 'always';
}

export interface CliOnboardingSequenceResult {
  status: 'ready' | 'global-aborted';
  global: 'not-needed' | 'committed' | 'aborted';
  workspace: 'not-needed' | ProjectOnboardingResult['status'] | 'failed';
  /** A project setup failure is non-fatal once global setup is durable. */
  workspaceError?: string;
  config?: Config;
  /** True only when the global wizard explicitly chose MCP Skip in this run. */
  skipMcpForLaunch: boolean;
}

const DEFAULT_DEPENDENCIES: CliOnboardingDependencies = {
  recoverGlobalSetup: recoverGlobalSetupState,
  hasGlobalSetup: () => isRegularFileNoFollow(getConfigPath()) && isOnboarded(),
  hasWorkspaceSetup: isWorkspaceOnboarded,
  runGlobalSetup: (workspaceRoot) => runWizard({ workspaceRoot }),
  runWorkspaceSetup: (workspaceRoot) => runProjectOnboarding(workspaceRoot),
};

/** Await both applicable flows before the caller constructs any session state. */
export async function runCliOnboardingSequence(
  options: CliOnboardingSequenceOptions,
  dependencies: CliOnboardingDependencies = DEFAULT_DEPENDENCIES,
): Promise<CliOnboardingSequenceResult> {
  // Recovery must precede both predicates. A crash can temporarily hide the
  // config at its claim path; checking existence first would otherwise
  // short-circuit `isOnboarded` and let the wizard derive from a blank config.
  dependencies.recoverGlobalSetup();
  const needsGlobal = options.global === 'always' || !dependencies.hasGlobalSetup();
  let global: CliOnboardingSequenceResult['global'] = 'not-needed';
  let config: Config | undefined;
  let skipMcpForLaunch = false;

  if (needsGlobal) {
    const result = await dependencies.runGlobalSetup(options.workspaceRoot);
    if (!result.state.committed) {
      return {
        status: 'global-aborted',
        global: 'aborted',
        workspace: 'not-needed',
        skipMcpForLaunch: false,
      };
    }
    global = 'committed';
    config = result.config;
    skipMcpForLaunch = result.skipMcpForLaunch === true;
  }

  let workspace: CliOnboardingSequenceResult['workspace'] = 'not-needed';
  let workspaceError: string | undefined;
  if (!dependencies.hasWorkspaceSetup(options.workspaceRoot)) {
    try {
      const result = await dependencies.runWorkspaceSetup(options.workspaceRoot);
      workspace = result.status;
    } catch (err) {
      // The global wizard committed independently and must never appear rolled
      // back because the optional per-workspace step hit a filesystem/UI error.
      // Return the durable global result so startup and `/init config` can apply
      // it immediately, surface a truthful warning, and keep the session usable.
      workspace = 'failed';
      workspaceError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: 'ready',
    global,
    workspace,
    skipMcpForLaunch,
    ...(workspaceError ? { workspaceError } : {}),
    ...(config ? { config } : {}),
  };
}
