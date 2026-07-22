/**
 * read-only assisted workspace onboarding orchestration.
 *
 * The service performs one bounded repository scan and at most one injected
 * model call. Any unavailable, failed, timed-out, oversized, or invalid model
 * response converges on the deterministic preset proposal. It never writes;
 * CLI and Desktop own review, confirmation, and the existing transaction.
 */
import path from 'node:path';
import {
  createWorkspaceManifest,
} from './manifest.js';
import {
  ONBOARDING_PROPOSAL_MAX_RAW_BYTES,
  normalizeWorkspaceInstructionTarget,
  parseWorkspaceOnboardingProposal,
  type WorkspaceOnboardingProposal,
} from './onboardingProposal.js';
import {
  buildWorkspaceOnboardingPrompt,
  WORKSPACE_ONBOARDING_PROPOSAL_TOOL,
} from './onboardingProposalPrompt.js';
import {
  suggestWorkspaceProfileFromScan,
  type ProfileSuggestion,
} from './profileSuggest.js';
import {
  scanRepository,
  type RepositoryScanOptions,
  type RepositoryScanSummary,
} from './repositoryScan.js';

export const ASSISTED_ONBOARDING_MODEL_TIMEOUT_MS = 15_000;

export interface WorkspaceOnboardingModelRequest {
  system: string;
  user: string;
  tool: typeof WORKSPACE_ONBOARDING_PROPOSAL_TOOL;
  toolChoice: { type: 'function'; function: { name: typeof WORKSPACE_ONBOARDING_PROPOSAL_TOOL.name } };
  /**
   * Adapters must enforce this ceiling while streaming/reading the provider
   * response, before they allocate and return the complete string.
   */
  maxOutputBytes: number;
  signal: AbortSignal;
}

/** The clients adapt their live selected/session model to this single-call port. */
export type WorkspaceOnboardingModelCompletion = (
  request: WorkspaceOnboardingModelRequest,
) => Promise<string>;

export type AssistedOnboardingFallbackReason =
  | 'model-unavailable'
  | 'model-timeout'
  | 'model-error'
  | 'invalid-model-output';

export interface AssistedOnboardingResult {
  proposal: WorkspaceOnboardingProposal;
  scan: RepositoryScanSummary;
  modelAttempted: boolean;
  fallbackReason?: AssistedOnboardingFallbackReason;
}

export interface AssistedOnboardingOptions {
  /**
   * Absolute workspace capability selected and authorized by the host. This is
   * never a model-supplied or repository-relative path; hosts must apply their
   * own workspace-access policy before invoking the in-process core service.
   */
  workspaceRoot: string;
  workspaceName?: string;
  description?: string;
  selectedInstructionPath?: string;
  complete?: WorkspaceOnboardingModelCompletion;
  scanOptions?: RepositoryScanOptions;
  /** Test seam for deterministic manifest timestamps. */
  now?: () => Date;
  /** Test seam; production values are always clamped to the 15-second cap. */
  timeoutMs?: number;
}

/** Produce a complete reviewable proposal without mutating the workspace. */
export async function proposeWorkspaceOnboarding(
  options: AssistedOnboardingOptions,
): Promise<AssistedOnboardingResult> {
  if (!path.isAbsolute(options.workspaceRoot)) {
    throw new Error('Assisted onboarding requires an absolute host-selected workspace root.');
  }
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const selectedInstructionPath = normalizeWorkspaceInstructionTarget(
    options.selectedInstructionPath ?? 'AGENT.md',
  );
  if (selectedInstructionPath === null) {
    throw new Error('Unsafe selected workspace instruction path.');
  }
  const date = options.now?.() ?? new Date();
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid assisted-onboarding timestamp.');
  const at = date.toISOString();
  const workspaceName = options.workspaceName ?? path.basename(workspaceRoot);
  const scan = scanRepository(workspaceRoot, options.scanOptions);
  const deterministicSuggestion = suggestWorkspaceProfileFromScan(scan);
  const fallback = deterministicProposal({
    workspaceName,
    selectedInstructionPath,
    at,
    suggestion: deterministicSuggestion,
  });

  const complete = options.complete;
  if (!complete) {
    return {
      proposal: fallback,
      scan,
      modelAttempted: false,
      fallbackReason: 'model-unavailable',
    };
  }

  const prompt = buildWorkspaceOnboardingPrompt({
    description: options.description,
    selectedInstructionPath,
    deterministicSuggestion,
    scan,
  });
  const controller = new AbortController();
  const timeoutMs = boundedTimeout(options.timeoutMs);
  try {
    const raw = await completeWithTimeout(
      () => complete({
        ...prompt,
        tool: WORKSPACE_ONBOARDING_PROPOSAL_TOOL,
        toolChoice: {
          type: 'function',
          function: { name: WORKSPACE_ONBOARDING_PROPOSAL_TOOL.name },
        },
        maxOutputBytes: ONBOARDING_PROPOSAL_MAX_RAW_BYTES,
        signal: controller.signal,
      }),
      controller,
      timeoutMs,
    );
    const proposal = parseWorkspaceOnboardingProposal(raw, {
      workspaceName,
      selectedInstructionPath,
      at,
    });
    if (!proposal) {
      return {
        proposal: fallback,
        scan,
        modelAttempted: true,
        fallbackReason: 'invalid-model-output',
      };
    }
    return { proposal, scan, modelAttempted: true };
  } catch (error) {
    return {
      proposal: fallback,
      scan,
      modelAttempted: true,
      fallbackReason: error instanceof AssistedOnboardingTimeoutError
        ? 'model-timeout'
        : 'model-error',
    };
  } finally {
    controller.abort();
  }
}

function deterministicProposal(input: {
  workspaceName: string;
  selectedInstructionPath: string;
  at: string;
  suggestion: ProfileSuggestion;
}): WorkspaceOnboardingProposal {
  return {
    source: 'deterministic',
    manifest: createWorkspaceManifest({
      name: input.workspaceName,
      profile: input.suggestion.profile,
      by: 'agent',
      at: input.at,
      overrides: { instructions: input.selectedInstructionPath },
    }),
    reasons: [...input.suggestion.reasons],
  };
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return ASSISTED_ONBOARDING_MODEL_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.trunc(value), ASSISTED_ONBOARDING_MODEL_TIMEOUT_MS));
}

function completeWithTimeout(
  complete: () => Promise<string>,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AssistedOnboardingTimeoutError());
    }, timeoutMs);
    try {
      complete().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

class AssistedOnboardingTimeoutError extends Error {}
