/**
 * Backend composition for exact-revision repository analysis.
 *
 * The checkout credential is one-shot and cleared as soon as Git fetch begins.
 * Concrete Git, parser, packet, and redaction adapters remain behind the
 * host-neutral campaign ports consumed by the durable review service.
 */

import { DeterministicImpactPacketAssembler } from "./impact/impactPacketAssembler.js";
import { relatedChangedPathsFromGraph } from "./index/relatedChangedPaths.js";
import { redactReviewSourceText } from "./repository-context/source-safety.js";
import { TypeScriptAssuranceIndexAdapter } from "./index/typeScriptIndex.js";
import type { RepositoryContextAnalysisPorts } from "./repositoryContextAssurance.js";
import { ExactShaCheckoutAdapter } from "./source/exactCheckout.js";

export interface RepositoryContextCheckoutAccess {
  remoteUrl: string;
  takeAuthorizationHeader(): string;
}

export interface RepositoryContextCompositionInput {
  checkout: RepositoryContextCheckoutAccess;
  maxDiffChars: number;
  isCancellationRequested(): boolean | Promise<boolean>;
}

export function createRepositoryContextAnalysisPorts(
  input: RepositoryContextCompositionInput,
): RepositoryContextAnalysisPorts {
  let checkoutAccess: RepositoryContextCheckoutAccess | null = input.checkout;
  const source = new ExactShaCheckoutAdapter({
    resolveAccess: async () => {
      const access = checkoutAccess;
      checkoutAccess = null;
      if (!access) throw new Error("Repository checkout authorization is no longer available.");
      return {
        remoteUrl: access.remoteUrl,
        authorizationHeader: access.takeAuthorizationHeader(),
      };
    },
  });
  const index = new TypeScriptAssuranceIndexAdapter({ checkouts: source });
  const impact = new DeterministicImpactPacketAssembler({
    indexes: index,
    checkouts: source,
    redact: ({ content }) => redactReviewSourceText(content),
  });
  const contextBudget = Math.max(
    1_024,
    Math.min(24 * 1_024, Math.floor(Math.max(1, input.maxDiffChars) / 2)),
  );
  return {
    source,
    index,
    impact,
    // ADR-033 D3 — the same retained checkout the packet assembler reads from,
    // exposed for the one file a review turns out to need. The adapter enforces
    // inventory membership and O_NOFOLLOW; nothing here widens that.
    readSourceFile: (checkoutRef, relativePath, maxBytes) =>
      source.readEligibleTextFile(checkoutRef, relativePath, maxBytes),
    // ADR-033 D2 — the review's units are grouped from the SAME exact-revision
    // graph the impact packets are assembled from. Deriving them here (rather
    // than from import lines that happen to be visible in a hunk) is what makes
    // "a route and its handler in one unit" true for a change that never
    // touched either file's import block.
    relatedChangedPaths: (indexRef, changedPaths) => {
      const handle = index.resolve(indexRef);
      return handle ? relatedChangedPathsFromGraph(handle, changedPaths) : [];
    },
    resolveArtifact: (ref) => impact.resolveArtifact(ref),
    releaseArtifacts: (refs) => impact.releaseArtifacts(refs),
    selectDeepReviewAnchors: (indexRef, limit) =>
      index.selectDeepReviewAnchors(indexRef, limit),
    isCancellationRequested: input.isCancellationRequested,
    maxModelContextBytes: contextBudget,
  };
}
