export type AuthorizedAssessmentTargetKind = 'domain' | 'repository';
export type AuthorizedAssessmentScanMode = 'code-review' | 'standard' | 'full-audit';

export interface AuthorizedAssessmentPolicy {
  schemaVersion: 1;
  policyHash: string;
  program: 'authorized_pentest';
  organizationId: string;
  target: {
    targetId: string;
    kind: AuthorizedAssessmentTargetKind;
    normalizedValue: string;
  };
  authorization: {
    authorizedBy: string;
    authorizedAt: string;
  };
  perimeter: {
    liveNetwork: boolean;
    allowedOrigins: string[];
    allowedRepositories: string[];
  };
  budget: {
    maxUsd: number;
    maxTokens: number;
    maxDurationMs: number;
  };
  cancellation: {
    mode: 'cooperative_fail_closed';
    pollIntervalMs: number;
  };
  evidence: {
    retentionDays: number;
    redactSecrets: true;
    rawRequestRetention: 'none';
  };
  scanMode: AuthorizedAssessmentScanMode;
  createdAt: string;
}
