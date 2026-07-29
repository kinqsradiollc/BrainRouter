/**
 * Host-side contracts for exact-revision repository-context composition.
 *
 * These shapes bind Core ports to backend-only artifact resolution and
 * cancellation without widening dependency-free shared contracts.
 */

import type {
  RepositoryAssuranceCampaignService,
  RepositoryAssuranceImpactPort,
  RepositoryAssuranceIndexPort,
  RepositoryAssuranceRunPort,
  RepositoryAssuranceSourcePort,
} from "@kinqs/brainrouter-core/review";
import type {
  AssurancePolicySnapshot,
  RepositoryAssuranceProgram,
} from "@kinqs/brainrouter-types/review";

export const MAX_REPOSITORY_MODEL_CONTEXT_BYTES = 256 * 1_024;

export function assertRepositoryModelContextLimit(value: number): void {
  if (
    !Number.isInteger(value)
    || value < 1
    || value > MAX_REPOSITORY_MODEL_CONTEXT_BYTES
  ) {
    throw new Error(
      `Repository model-context limit must be an integer between 1 and ${MAX_REPOSITORY_MODEL_CONTEXT_BYTES} bytes.`,
    );
  }
}

export function isSafeRepositoryRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\0\r\n]/.test(value)) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isSafeOpaqueArtifactRef(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export interface RepositoryContextArtifact {
  ref: string;
  content: string;
  byteCount: number;
}

export interface RepositoryContextAnalysisPorts {
  source: RepositoryAssuranceSourcePort;
  index: RepositoryAssuranceIndexPort;
  impact: RepositoryAssuranceImpactPort;
  resolveArtifact(ref: string): RepositoryContextArtifact | null;
  releaseArtifacts(refs: Iterable<string>): void | Promise<void>;
  isCancellationRequested?(): boolean | Promise<boolean>;
  maxModelContextBytes: number;
}

export interface RepositoryContextPrompt {
  text: string;
  packetRefs: string[];
  artifactRefs: string[];
}

export interface RepositoryContextAssuranceInput {
  runId: string;
  runs: RepositoryAssuranceRunPort;
  campaign: RepositoryAssuranceCampaignService;
  program: RepositoryAssuranceProgram;
  policy: AssurancePolicySnapshot;
  analysis: RepositoryContextAnalysisPorts;
  now?: () => string;
}
