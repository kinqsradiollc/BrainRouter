/** The three repository-review facts that must not be collapsed into "linked". */
export const REPOSITORY_REVIEW_STATE_KEYS = [
  'accountConnected',
  'repositoryAccessible',
  'autoReviewEnabled',
] as const;

export type RepositoryReviewStateKey = (typeof REPOSITORY_REVIEW_STATE_KEYS)[number];

export interface RepositoryReviewAvailability {
  /** The user completed GitHub or GitLab account authorization. */
  accountConnected: boolean;
  /** An App or account credential can read the repository now. */
  repositoryAccessible: boolean;
  /** The repository is enrolled in event-driven review automation. */
  autoReviewEnabled: boolean;
}
