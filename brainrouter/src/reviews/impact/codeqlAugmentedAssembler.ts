// ADR-039 S2 — augment the deterministic impact assembler with CodeQL taint paths.
//
// A non-invasive decorator over any RepositoryAssuranceImpactPort: it runs the
// base assembler (the TS-index source→sink analyzer) and then appends the CodeQL
// source→sink paths for the same revision as one extra impact packet. Both
// producers' paths flow through normalizeDeterministicCandidates as candidates on
// the same footing as model findings (ADR-039 D1).
//
// The CodeQL packet carries empty evidenceRefs: the path itself is the evidence
// (source → sink), which normalizeDeterministicCandidates accepts (its evidence
// check is vacuous for an empty ref list). Because the resulting candidate has no
// persisted evidence record, it is — exactly like a model finding — advisory
// review INPUT, not a blocking finding: the independent verifier adjudicates only
// evidence-bearing candidates (it filters `evidence.length > 0`, see
// diffReviewAssurance), so a CodeQL path informs the reviewer and the coverage
// statement without auto-blocking a merge. Blocking still requires the
// evidence-bearing, independently-verified deterministic path (ADR-039 D2, the
// conservative posture assuranceGate encodes). The D4 barrier model that keeps
// fixed code from re-reporting belongs in the taint engine, not here — see
// adr039BarrierPack.ts.
//
// The provider is injected and failure-tolerant. ADR-039 D5 / S5a — it reports
// one of two outcomes so the review can be HONEST about coverage:
//   • `analyzed`    — CodeQL ran for this revision. Zero paths then means
//                     genuinely clean; no packet, no limitation.
//   • `unavailable` — code scanning was off, had no analysis for the ref, or
//                     the fetch failed. The decorator attaches a
//                     CODEQL_NOT_ANALYZED coverage limitation so the published
//                     review says "not analyzed" instead of implying safety
//                     (Golden rule 23 — absence of a finding is not absence of a
//                     defect). Any thrown provider error is treated as
//                     `unavailable` for the same reason.
// The limitation rides on `assembly.limitations`, which the repository-context
// session folds into the run coverage independent of findings, so it surfaces
// even on a review that reports nothing else.

import type {
  AssuranceOperationCancellation,
  RepositoryAssuranceImpactPort,
} from "@kinqs/brainrouter-core/review";
import type {
  AssembleAssuranceImpactPacketsInput,
  AssuranceCoverageLimitation,
  AssuranceImpactPacket,
  AssuranceImpactPacketAssembly,
  AssuranceSourceToSinkPath,
} from "@kinqs/brainrouter-types/review";

/**
 * A CodeQL taint-path fetch outcome. `unavailable` is distinct from an empty
 * `analyzed` result so the review never conflates "code scanning did not run"
 * with "code scanning ran and found nothing" (ADR-039 D5 / §4 honesty).
 */
export type CodeqlPathsResult =
  | { status: "analyzed"; paths: AssuranceSourceToSinkPath[] }
  | { status: "unavailable"; reasonCode: string };

/** Supplies the CodeQL taint outcome for an assemble request (repo + revision). */
export type CodeqlPathProvider = (
  input: AssembleAssuranceImpactPacketsInput,
) => Promise<CodeqlPathsResult>;

/** Stable id for the "CodeQL did not analyze this revision" coverage limitation. */
export const CODEQL_NOT_ANALYZED_LIMITATION_ID = "codeql-not-analyzed";

export class CodeqlAugmentedImpactAssembler
  implements RepositoryAssuranceImpactPort
{
  constructor(
    private readonly base: RepositoryAssuranceImpactPort,
    private readonly provider: CodeqlPathProvider,
  ) {}

  async assemble(
    input: AssembleAssuranceImpactPacketsInput,
    cancellation?: AssuranceOperationCancellation,
  ): Promise<AssuranceImpactPacketAssembly> {
    const assembly = await this.base.assemble(input, cancellation);

    let result: CodeqlPathsResult;
    try {
      result = await this.provider(input);
    } catch {
      result = { status: "unavailable", reasonCode: "PROVIDER_ERROR" };
    }

    if (result.status === "unavailable") {
      // Say "not analyzed" — never let a missing CodeQL run read as clean.
      const limitation: AssuranceCoverageLimitation = {
        id: CODEQL_NOT_ANALYZED_LIMITATION_ID,
        component: "codeql_taint",
        state: "unavailable",
        reasonCode: result.reasonCode || "CODEQL_UNAVAILABLE",
        summary:
          "CodeQL taint analysis did not run for this revision; source→sink paths were not analyzed. Absence of a CodeQL path is not evidence of safety.",
      };
      return {
        ...assembly,
        limitations: [
          ...assembly.limitations.filter((item) => item.id !== limitation.id),
          limitation,
        ],
      };
    }

    // Analyzed. Zero paths is a genuine clean result — no packet, no limitation.
    if (!result.paths.length) return assembly;

    const codeqlPacket: AssuranceImpactPacket = {
      id: `codeql:${assembly.revisionSha}`,
      revisionSha: assembly.revisionSha,
      program: input.program,
      changed: [],
      context: [],
      sourceToSinkPaths: result.paths,
      artifactRefs: [],
      byteCount: 0,
      truncated: false,
      limitationIds: [],
    };
    return { ...assembly, packets: [...assembly.packets, codeqlPacket] };
  }
}
