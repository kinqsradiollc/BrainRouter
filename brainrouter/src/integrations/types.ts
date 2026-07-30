/**
 * Integration configs (ADR-010 P6 / ADR-009) — org-scoped external integrations,
 * chiefly the org's own GitHub App bot. Secrets (App private key + webhook
 * secret) are sealed at rest; the public record never carries them.
 */

export type IntegrationKind = "github_app";
export const INTEGRATION_KINDS: readonly IntegrationKind[] = ["github_app"];
export function isIntegrationKind(x: unknown): x is IntegrationKind {
  return typeof x === "string" && (INTEGRATION_KINDS as readonly string[]).includes(x);
}

/** Public record — no secret. `hasSecret` reflects whether one is stored. */
export interface IntegrationConfigRecord {
  id: string;
  orgId: string;
  kind: IntegrationKind;
  enabled: boolean;
  /** Non-secret settings (github_app: appId, installationId, apiBase). */
  config: Record<string, unknown>;
  hasSecret: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Create/update input. `secret` is plaintext in; sealed at rest. */
export interface IntegrationConfigInput {
  kind: IntegrationKind;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** github_app: { privateKey, webhookSecret }. Omit to keep an existing secret. */
  secret?: Record<string, string>;
}

/** A decrypted integration the ingress consumes (secret opened). */
export interface ResolvedIntegration {
  kind: IntegrationKind;
  config: Record<string, unknown>;
  secret: Record<string, string>;
}
