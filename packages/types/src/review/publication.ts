/**
 * Host-neutral repository-assurance publication projection.
 *
 * The assurance domain computes this record once from its gate decision. Forge,
 * API, CLI, Desktop, and Dashboard consumers then present the same state instead
 * of independently translating lifecycle evidence into publication authority.
 */

export const ASSURANCE_PUBLICATION_STATUSES = [
  'running',
  'clean',
  'advisory',
  'blocked',
  'partial',
  'failed',
  'canceled',
  'superseded',
  'stale',
] as const;

export type AssurancePublicationStatus = (typeof ASSURANCE_PUBLICATION_STATUSES)[number];

export type AssurancePublicationConclusion = 'success' | 'neutral' | 'failure';

export interface AssurancePublicationProjection {
  schemaVersion: 1;
  status: AssurancePublicationStatus;
  label: string;
  conclusion: AssurancePublicationConclusion;
  blocked: boolean;
  cleanEligible: boolean;
  reason: string;
  blockingFindingIds: string[];
}
