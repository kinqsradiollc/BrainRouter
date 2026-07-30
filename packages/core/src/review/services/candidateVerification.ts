/**
 * Evidence-bound candidate verification.
 *
 * A verifier may only disposition a finding for the campaign's exact program
 * and revision, and every cited verifier reference must exist on the finding.
 */

import type { AssuranceFinding } from '@kinqs/brainrouter-types/review';
import type { AssuranceCampaignDependencies } from './assuranceCampaign.js';

export async function verifyAssuranceCandidate(
  deps: AssuranceCampaignDependencies,
  runId: string,
  findingId: string,
): Promise<AssuranceFinding> {
  if (!deps.findings || !deps.verifier) {
    throw new Error('Candidate verification ports are unavailable.');
  }
  const [run, finding] = await Promise.all([
    deps.runs.get(runId),
    deps.findings.get(findingId),
  ]);
  if (!run) throw new Error(`Repository assurance run ${runId} was not found.`);
  if (!finding) throw new Error(`Assurance finding ${findingId} was not found.`);
  if (finding.program !== run.program || finding.revisionSha !== run.revision.headSha) {
    throw new Error('Candidate program and revision must match the assurance run.');
  }
  if (
    (finding.state === 'verified' || finding.state === 'validated' || finding.state === 'disputed')
    && finding.verifier
  ) {
    return finding;
  }
  if (
    finding.state !== 'candidate'
    && finding.state !== 'hotspot'
    && finding.state !== 'insufficient_evidence'
  ) {
    throw new Error(`Finding ${finding.id} is not eligible for candidate verification.`);
  }
  const disposition = await deps.verifier.verify({ run, finding });
  if (
    !disposition.verifierId.trim()
    || !disposition.rationale.trim()
    || !disposition.decidedAt.trim()
    || disposition.evidenceRefs.length === 0
    || !disposition.evidenceRefs.every((id) =>
      finding.evidence.some((evidence) => evidence.id === id),
    )
  ) {
    throw new Error('Candidate verifier returned unsupported disposition evidence.');
  }
  return deps.findings.save({
    ...finding,
    state: disposition.state,
    verifier: disposition,
    updatedAt: disposition.decidedAt,
  });
}
