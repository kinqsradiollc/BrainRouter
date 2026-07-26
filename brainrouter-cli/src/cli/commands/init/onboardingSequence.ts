/** Ordered coordination for the CLI's global and per-workspace setup flows. */
import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath, loadConfig, type Config } from '@kinqs/brainrouter-core/config';
import { isWorkspaceOnboarded } from '@kinqs/brainrouter-core/workspace';
import { runWizard } from '../../ink/wizard/runWizard.js';
import { safeOnboardingError } from './onboardingErrors.js';
import { runProjectOnboarding, type ProjectOnboardingResult } from './projectOnboard.js';

export interface GlobalOnboardingResult {
  state: { committed: boolean; aborted: boolean };
  config?: Config;
  mcpSkipped?: boolean;
}

export interface CliOnboardingDependencies {
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
  workspaceError?: string;
  config?: Config;
  mcpSkipped: boolean;
}

const DEFAULT_DEPENDENCIES: CliOnboardingDependencies = {
  hasGlobalSetup: () => {
    const configPath = getConfigPath();
    return isRegularFileNoFollow(configPath) &&
      isRegularFileNoFollow(path.join(path.dirname(configPath), '.onboarded'));
  },
  hasWorkspaceSetup: isWorkspaceOnboarded,
  runGlobalSetup: async (workspaceRoot) => {
    const result = await runWizard({ workspaceRoot });
    return {
      state: result.state,
      ...(result.config ? { config: result.config } : {}),
      mcpSkipped: result.state.draft.mcp?.kind === 'skip',
    };
  },
  runWorkspaceSetup: (workspaceRoot) => runProjectOnboarding(workspaceRoot, {
    getConfig: loadConfig,
  }),
};

/** Await every applicable setup before callers construct session runtime state. */
export async function runCliOnboardingSequence(
  options: CliOnboardingSequenceOptions,
  dependencies: CliOnboardingDependencies = DEFAULT_DEPENDENCIES,
): Promise<CliOnboardingSequenceResult> {
  const needsGlobal = options.global === 'always' || !dependencies.hasGlobalSetup();
  let global: CliOnboardingSequenceResult['global'] = 'not-needed';
  let config: Config | undefined;
  let mcpSkipped = false;

  if (needsGlobal) {
    const result = await dependencies.runGlobalSetup(options.workspaceRoot);
    if (!result.state.committed) {
      return {
        status: 'global-aborted',
        global: 'aborted',
        workspace: 'not-needed',
        mcpSkipped: false,
      };
    }
    global = 'committed';
    config = result.config;
    mcpSkipped = result.mcpSkipped === true;
  }

  let workspace: CliOnboardingSequenceResult['workspace'] = 'not-needed';
  let workspaceError: string | undefined;
  if (!dependencies.hasWorkspaceSetup(options.workspaceRoot)) {
    try {
      workspace = (await dependencies.runWorkspaceSetup(options.workspaceRoot)).status;
    } catch (error) {
      workspace = 'failed';
      workspaceError = safeOnboardingError(error);
    }
  }

  return {
    status: 'ready',
    global,
    workspace,
    mcpSkipped,
    ...(workspaceError ? { workspaceError } : {}),
    ...(config ? { config } : {}),
  };
}

function isRegularFileNoFollow(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
