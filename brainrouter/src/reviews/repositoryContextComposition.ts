/**
 * Backend composition for exact-revision repository analysis.
 *
 * The checkout credential is one-shot and cleared as soon as Git fetch begins.
 * Concrete Git, parser, packet, and redaction adapters remain behind the
 * host-neutral campaign ports consumed by the durable review service.
 */

import { redactSensitiveMemoryText } from "../memory/util/redaction.js";
import { DeterministicImpactPacketAssembler } from "./impact/impactPacketAssembler.js";
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
    redact: ({ content }) => redactSensitiveMemoryText(content),
  });
  const contextBudget = Math.max(
    1_024,
    Math.min(24 * 1_024, Math.floor(Math.max(1, input.maxDiffChars) / 2)),
  );
  return {
    source,
    index,
    impact,
    resolveArtifact: (ref) => impact.resolveArtifact(ref),
    releaseArtifacts: (refs) => impact.releaseArtifacts(refs),
    selectDeepReviewAnchors: (indexRef, limit) =>
      index.selectDeepReviewAnchors(indexRef, limit),
    isCancellationRequested: input.isCancellationRequested,
    maxModelContextBytes: contextBudget,
  };
}
