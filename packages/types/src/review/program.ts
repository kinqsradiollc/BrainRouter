/** Repository-assurance programs retain distinct authority and publication rules. */
export const REPOSITORY_ASSURANCE_PROGRAMS = [
  'code_review',
  'security_review',
  'authorized_pentest',
] as const;

export type RepositoryAssuranceProgram = (typeof REPOSITORY_ASSURANCE_PROGRAMS)[number];

/** A host-neutral repository identity pinned by the execution adapter. */
export interface RepositoryRef {
  forge: 'github' | 'gitlab' | 'local';
  /** Forge-qualified slug (for example, owner/repository), or a local stable id. */
  slug: string;
  repositoryId?: string;
  defaultBranch?: string;
}

/** The immutable source revision evaluated by one assurance run. */
export interface RepositoryRevision {
  headSha: string;
  baseSha?: string;
  mergeBaseSha?: string;
}
