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
  AssuranceImpactRelationship,
  AssurancePolicySnapshot,
  AssuranceSourceLocation,
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
  /** Exact revision the retained source bytes came from. */
  revisionSha: string;
  /** Changed anchors whose deterministic graph traversal selected this artifact. */
  anchorLocations: AssuranceSourceLocation[];
  /** Exact source range serialized in `content`, before any aggregate prompt truncation. */
  sourceLocation: AssuranceSourceLocation;
  /** Why the graph retained this source for the anchor, stable and deduplicated. */
  roles: AssuranceImpactRelationship[];
  content: string;
  byteCount: number;
}

export interface RepositoryContextAnalysisPorts {
  source: RepositoryAssuranceSourcePort;
  index: RepositoryAssuranceIndexPort;
  impact: RepositoryAssuranceImpactPort;
  resolveArtifact(ref: string): RepositoryContextArtifact | null;
  releaseArtifacts(refs: Iterable<string>): void | Promise<void>;
  /**
   * ADR-033 D3 — read ONE inventoried text file from the retained checkout.
   *
   * Optional because a composition without a checkout has nothing to read from,
   * and the deterministic packet remains the floor either way: this exists for
   * the question the packet assembler could not have predicted, not to replace
   * it. Reads stay inside the checkout — the adapter serves inventoried paths
   * only and opens with `O_NOFOLLOW`.
   */
  readSourceFile?(checkoutRef: string, relativePath: string, maxBytes: number): Promise<string>;
  /**
   * ADR-033 D2 — the related-file edges among the changed paths, read off the
   * parser-backed index built at the reviewed revision.
   *
   * Optional because a composition without an index still plans bundles (path
   * adjacency and the diff's own import lines remain), and this only ever adds
   * edges BETWEEN files already in the changeset.
   */
  relatedChangedPaths?(indexRef: string, changedPaths: string[]): Array<[string, string]>;
  selectDeepReviewAnchors?(indexRef: string, limit: number): {
    anchors: AssuranceSourceLocation[];
    indexedFiles: number;
  };
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
