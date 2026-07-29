/**
 * Pure coverage projection for parser and impact-packet stages.
 *
 * Coverage is derived only from durable receipts and exact changed anchors;
 * unavailable or unmatched evidence always remains explicit and partial.
 */

import type {
  AssuranceCodeIndexResult,
  AssuranceCoverage,
  AssuranceCoverageLimitation,
  AssuranceImpactPacketAssembly,
  AssuranceSourceLocation,
  RepositoryAssuranceRun,
} from "@kinqs/brainrouter-types/review";

export function coverageLimitation(
  id: string,
  component: string,
  state: AssuranceCoverageLimitation["state"],
  reasonCode: string,
  summary: string,
  affectedPaths?: string[],
): AssuranceCoverageLimitation {
  return {
    id,
    component,
    state,
    reasonCode,
    summary,
    ...(affectedPaths?.length ? { affectedPaths: affectedPaths.slice(0, 100) } : {}),
  };
}

export function dedupeCoverageLimitations(
  limitations: AssuranceCoverageLimitation[],
): AssuranceCoverageLimitation[] {
  return [...new Map(limitations.map((item) => [item.id, item])).values()];
}

export function parserCoverage(
  run: RepositoryAssuranceRun,
  index: AssuranceCodeIndexResult | null,
  limitations: AssuranceCoverageLimitation[],
  calculatedAt: string,
): AssuranceCoverage {
  const source = run.sourceSnapshot;
  const filesEligible = index?.receipt.filesEligible ?? source.textFileCount;
  const filesAnalyzed = index?.receipt.filesIndexed ?? 0;
  const state = !index
    ? "unavailable"
    : index.receipt.status === "ready"
      ? "covered"
      : index.receipt.status === "failed"
        ? "failed"
        : "partial";
  return {
    status: limitations.length || state !== "covered" ? "partial" : "complete",
    filesTotal: source.fileCount,
    filesEligible,
    filesAnalyzed,
    changedFilesTotal: run.coverage.changedFilesTotal,
    changedFilesAnalyzed: run.coverage.changedFilesAnalyzed,
    analyzers: [{
      analyzerId: index?.receipt.analyzerId ?? "typescript-parser-index",
      ...(index?.receipt.analyzerVersion ? { analyzerVersion: index.receipt.analyzerVersion } : {}),
      state,
      supportedLanguages: index?.receipt.supportedLanguages ?? ["typescript", "javascript"],
      filesEligible,
      filesAnalyzed,
      diagnosticsProduced: 0,
      limitationIds: limitations.map((item) => item.id),
    }],
    limitations,
    calculatedAt,
  };
}

export function packetCoverage(
  run: RepositoryAssuranceRun,
  index: AssuranceCodeIndexResult,
  assembly: AssuranceImpactPacketAssembly | null,
  changed: AssuranceSourceLocation[],
  limitations: AssuranceCoverageLimitation[],
  calculatedAt: string,
): AssuranceCoverage {
  const changedPaths = new Set(changed.map((location) => location.path));
  const unmatchedPaths = new Set(
    limitations
      .filter((item) => item.reasonCode === "IMPACT_CHANGED_ANCHOR_UNMATCHED")
      .flatMap((item) => item.affectedPaths ?? []),
  );
  const analyzedPaths = new Set(
    (assembly?.packets ?? [])
      .flatMap((packet) => packet.changed)
      .map((location) => location.path)
      .filter((path) => !unmatchedPaths.has(path)),
  );
  const impactLimitationIds = assembly?.limitations.map((item) => item.id) ?? [];
  return {
    status: limitations.length || analyzedPaths.size < changedPaths.size ? "partial" : "complete",
    filesTotal: run.sourceSnapshot.fileCount,
    filesEligible: index.receipt.filesEligible,
    filesAnalyzed: index.receipt.filesIndexed,
    changedFilesTotal: changedPaths.size,
    changedFilesAnalyzed: analyzedPaths.size,
    analyzers: [
      {
        analyzerId: index.receipt.analyzerId,
        analyzerVersion: index.receipt.analyzerVersion,
        state: index.receipt.status === "ready"
          ? "covered"
          : index.receipt.status === "failed"
            ? "failed"
            : "partial",
        supportedLanguages: index.receipt.supportedLanguages,
        filesEligible: index.receipt.filesEligible,
        filesAnalyzed: index.receipt.filesIndexed,
        diagnosticsProduced: 0,
        limitationIds: index.receipt.limitationIds,
      },
      {
        analyzerId: "deterministic-impact-packets",
        state: !assembly
          ? "unavailable"
          : impactLimitationIds.length
            ? "partial"
            : "covered",
        supportedLanguages: index.receipt.supportedLanguages,
        filesEligible: changedPaths.size,
        filesAnalyzed: analyzedPaths.size,
        diagnosticsProduced: assembly?.packets.length ?? 0,
        limitationIds: impactLimitationIds,
      },
    ],
    limitations,
    calculatedAt,
  };
}
