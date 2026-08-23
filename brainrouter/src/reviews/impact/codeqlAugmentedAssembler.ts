// ADR-039 S2 — augment the deterministic impact assembler with CodeQL taint paths.
//
// A non-invasive decorator over any RepositoryAssuranceImpactPort: it runs the
// base assembler (the TS-index source→sink analyzer) and then appends the CodeQL
// source→sink paths for the same revision as one extra impact packet. Both
// producers' paths then flow through the SAME seam — normalizeDeterministic
// candidates → verifyCandidate (D2) → the publication gate — as candidates on the
// same footing as model findings (ADR-039 D1).
//
// The CodeQL packet carries empty evidenceRefs: the path itself is the evidence
// (source → sink), which normalizeDeterministicCandidates accepts (its evidence
// check is vacuous for an empty ref list). The verifier adjudicates reachability.
//
// The provider is injected and failure-tolerant: any error, or code scanning
// being unavailable for the revision, yields no extra packet — the review still
// runs on the base assembler's output and reports "not analyzed" for the CodeQL
// half elsewhere, never treating absence as safety.

import type {
  AssuranceOperationCancellation,
  RepositoryAssuranceImpactPort,
} from "@kinqs/brainrouter-core/review";
import type {
  AssembleAssuranceImpactPacketsInput,
  AssuranceImpactPacket,
  AssuranceImpactPacketAssembly,
  AssuranceSourceToSinkPath,
} from "@kinqs/brainrouter-types/review";

/** Supplies CodeQL source→sink paths for an assemble request (repo + revision). */
export type CodeqlPathProvider = (
  input: AssembleAssuranceImpactPacketsInput,
) => Promise<AssuranceSourceToSinkPath[]>;

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

    let paths: AssuranceSourceToSinkPath[] = [];
    try {
      paths = await this.provider(input);
    } catch {
      paths = [];
    }
    if (!paths.length) return assembly;

    const codeqlPacket: AssuranceImpactPacket = {
      id: `codeql:${assembly.revisionSha}`,
      revisionSha: assembly.revisionSha,
      program: input.program,
      changed: [],
      context: [],
      sourceToSinkPaths: paths,
      artifactRefs: [],
      byteCount: 0,
      truncated: false,
      limitationIds: [],
    };
    return { ...assembly, packets: [...assembly.packets, codeqlPacket] };
  }
}
