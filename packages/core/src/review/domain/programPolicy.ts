/**
 * Repository-assurance program authority defaults.
 *
 * Program identity is not a cosmetic lens label: each program has distinct
 * authorization, publication, evidence, and blocking authority. Hosts may
 * tighten these defaults but cannot infer broader authority from another lens.
 */

import type { RepositoryAssuranceProgram } from '@kinqs/brainrouter-types/review';

export interface RepositoryAssuranceProgramPolicy {
  program: RepositoryAssuranceProgram;
  authorization: 'repository_read' | 'security_review' | 'explicit_target_authorization';
  publication: 'advisory' | 'verified_findings' | 'restricted_report';
  minimumEvidence: 'source_anchor' | 'independent_verification' | 'reproduction_receipt';
  blockingAuthority: 'none' | 'policy_gated' | 'explicit_policy_only';
}

const PROGRAM_POLICIES: Record<
  RepositoryAssuranceProgram,
  RepositoryAssuranceProgramPolicy
> = {
  code_review: {
    program: 'code_review',
    authorization: 'repository_read',
    publication: 'advisory',
    minimumEvidence: 'source_anchor',
    blockingAuthority: 'none',
  },
  security_review: {
    program: 'security_review',
    authorization: 'security_review',
    publication: 'verified_findings',
    minimumEvidence: 'independent_verification',
    blockingAuthority: 'policy_gated',
  },
  authorized_pentest: {
    program: 'authorized_pentest',
    authorization: 'explicit_target_authorization',
    publication: 'restricted_report',
    minimumEvidence: 'reproduction_receipt',
    blockingAuthority: 'explicit_policy_only',
  },
};

export function repositoryAssuranceProgramPolicy(
  program: RepositoryAssuranceProgram,
): RepositoryAssuranceProgramPolicy {
  return { ...PROGRAM_POLICIES[program] };
}

/** Compatibility mapping for the three maintained legacy review lens ids. */
export function repositoryAssuranceProgramForLens(
  lens: string,
): RepositoryAssuranceProgram | null {
  if (lens === 'code') return 'code_review';
  if (lens === 'security') return 'security_review';
  if (lens === 'pentest') return 'authorized_pentest';
  return null;
}
