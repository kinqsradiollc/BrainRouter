/**
 * ADR-033 D7 — production-equivalent evidence for the local review benchmark.
 *
 * Every case is checked out through the same exact-SHA adapter as the hosted
 * review, indexed by the same TypeScript graph, assembled into the same bounded
 * redacted impact packets, and served through the same read-only file-access
 * boundary. No forge or network is involved: the current repository is the
 * local source remote, pinned to the frozen case SHA.
 */
import { join } from "node:path";
import type {
  AssuranceCoverageLimitation,
  AssuranceImpactPacketAssembly,
} from "@kinqs/brainrouter-types/review";
import { prepareReviewDiffSource } from "@kinqs/brainrouter-core/review";
import { changedSourceLocations } from "../src/integrations/reviewDiffChunks.js";
import { redactSensitiveMemoryText } from "../src/memory/util/redaction.js";
import { DeterministicImpactPacketAssembler } from "../src/reviews/impact/impactPacketAssembler.js";
import { relatedChangedPathsFromGraph } from "../src/reviews/index/relatedChangedPaths.js";
import { TypeScriptAssuranceIndexAdapter } from "../src/reviews/index/typeScriptIndex.js";
import { createReviewFileAccess } from "../src/reviews/reviewFileAccess.js";
import { buildRepositoryContextPrompt } from "../src/reviews/repository-context/prompt.js";
import { ExactShaCheckoutAdapter } from "../src/reviews/source/exactCheckout.js";
import type { ReviewBenchmarkCaseEvidence } from "../src/reviews/benchmark/reviewBenchmarkHarness.js";
import type { ReviewBenchmarkCase } from "../src/reviews/benchmark/reviewBenchmark.js";


/**
 * ADR-033 — repository-context evidence budget for ONE review, however many
 * units it splits into. Matches what a single-call review was always given, so
 * bundling changes how evidence is DIVIDED and not how much of it there is.
 */
export const REVIEW_CONTEXT_BUDGET_BYTES = 24 * 1_024;
const MAX_BUNDLE_CHARS = 60_000;
const PACKET_LIMITS = {
  maxPackets: 20,
  maxPacketBytes: 16_000,
  maxFilesPerPacket: 12,
};

export interface PreparedReviewBenchmarkEvidence {
  evidence: ReviewBenchmarkCaseEvidence;
  cleanup(): Promise<void>;
}

function limitationCodes(limitations: readonly AssuranceCoverageLimitation[]): string[] {
  return [...new Set(limitations.map((item) => item.reasonCode))].sort();
}

export async function prepareReviewBenchmarkEvidence(input: {
  benchmarkCase: ReviewBenchmarkCase;
  diff: string;
  repositoryRoot: string;
  lensId: string;
  tempRoot?: string;
}): Promise<PreparedReviewBenchmarkEvidence> {
  const preparedDiff = prepareReviewDiffSource(input.diff);
  if (!preparedDiff.diff.trim() || preparedDiff.excludedPaths.length > 0) {
    throw new Error(
      `Qualifying benchmark diff coverage was unavailable for ${input.benchmarkCase.id}: ${preparedDiff.excludedPaths.length} source-policy exclusion(s).`,
    );
  }
  const runId = `review-benchmark:${input.benchmarkCase.id}`;
  const repository = { forge: "local" as const, slug: input.repositoryRoot };
  const revision = { headSha: input.benchmarkCase.sha };
  const source = new ExactShaCheckoutAdapter({
    resolveAccess: async () => ({ remoteUrl: input.repositoryRoot }),
    ...(input.tempRoot ? { tempRoot: join(input.tempRoot, input.benchmarkCase.id) } : {}),
  });
  const prepared = await source.prepare({ runId, repository, revision });
  const checkoutRef = prepared.source.checkoutRef;
  if (!checkoutRef) throw new Error(`Exact source checkout was unavailable for ${input.benchmarkCase.id}.`);

  const index = new TypeScriptAssuranceIndexAdapter({ checkouts: source });
  const impact = new DeterministicImpactPacketAssembler({
    indexes: index,
    checkouts: source,
    redact: ({ content }) => redactSensitiveMemoryText(content),
  });
  let indexRef: string | null = null;
  let artifactRefs: string[] = [];
  let impactAssembly: AssuranceImpactPacketAssembly | null = null;
  let repositoryContext = "";
  let relatedPaths: Array<[string, string]> = [];
  const limitations: AssuranceCoverageLimitation[] = [...prepared.limitations];

  const releasePreparedEvidence = async (): Promise<void> => {
    impact.releaseArtifacts(artifactRefs);
    if (indexRef) await index.release(indexRef);
    await source.release(checkoutRef);
  };

  try {
    const indexed = await index.update({ runId, repository, revision, checkoutRef });
    indexRef = indexed.receipt.indexRef;
    if (!indexRef) throw new Error("Parser index returned no exact-revision reference.");
    limitations.push(...indexed.limitations);
    const graph = index.resolve(indexRef);
    if (!graph) throw new Error("Parser index could not resolve its exact-revision graph.");
    const changed = changedSourceLocations(preparedDiff.diff);
    if (changed.length === 0) throw new Error("Frozen diff contains no changed source locations.");
    const changedPaths = [...new Set(changed.map((location) => location.path))];
    relatedPaths = relatedChangedPathsFromGraph(graph, changedPaths);

    const assembly = await impact.assemble({
      runId,
      repository,
      revision,
      program: input.lensId === "security" ? "security_review" : "code_review",
      checkoutRef,
      indexRef,
      changed,
      redactionPolicyId: "pr-review-default",
      limits: {
        ...PACKET_LIMITS,
        maxPacketBytes: Math.max(1_024, Math.min(PACKET_LIMITS.maxPacketBytes, MAX_BUNDLE_CHARS)),
      },
    });
    impactAssembly = assembly;
    limitations.push(...assembly.limitations);
    artifactRefs = assembly.packets.flatMap((packet) => packet.artifactRefs);
    if (assembly.packets.length === 0) {
      throw new Error("Impact packet assembly returned no exact-revision packets.");
    }
    repositoryContext = buildRepositoryContextPrompt({
      assembly,
      limitations,
      resolveArtifact: (ref) => impact.resolveArtifact(ref),
      maxBytes: 24 * 1_024,
    }).prompt?.text ?? "";
    if (!repositoryContext.trim()) {
      throw new Error("Impact packet assembly returned no model-visible exact-revision context.");
    }
  } catch (error) {
    await releasePreparedEvidence();
    throw new Error(
      `Qualifying parser/index/impact evidence was unavailable for ${input.benchmarkCase.id}: ${error instanceof Error ? error.message : "unknown evidence failure"}`,
    );
  }

  const assemblyForProjection = impactAssembly;
  return {
    evidence: {
      diff: preparedDiff.diff,
      repositoryContext,
      ...(assemblyForProjection
        ? {
            // `maxBytes` is the caller's when it has one: the review that split
            // itself into units is the only party that knows how many units share
            // the budget. Absent, this is the whole-review cap, which is exactly
            // right for a review that stayed one unit.
            repositoryContextForPaths: (
              paths: readonly string[],
              _diffEvidence?: string,
              maxBytes?: number,
            ) =>
              buildRepositoryContextPrompt({
                assembly: assemblyForProjection,
                limitations,
                resolveArtifact: (ref) => impact.resolveArtifact(ref),
                maxBytes: maxBytes ?? REVIEW_CONTEXT_BUDGET_BYTES,
                changedPaths: paths,
              }).prompt?.text ?? "",
          }
        : {}),
      relatedPaths,
      createFileAccess: () => createReviewFileAccess({
        readSourceFile: (path, maxBytes) => source.readEligibleTextFile(checkoutRef, path, maxBytes),
      }),
      provenance: {
        source: "exact-sha-local-checkout",
        revision: input.benchmarkCase.sha,
        repositoryContext: repositoryContext ? "production-impact-packets" : "unavailable",
        relationships: "production-parser-graph",
        limitations: limitationCodes(limitations),
      },
    },
    async cleanup(): Promise<void> {
      await releasePreparedEvidence();
    },
  };
}
