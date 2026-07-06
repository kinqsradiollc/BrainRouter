/**
 * IntegrationStore — org-scoped external-integration config (ADR-010 P6).
 * Backend-local; `PostgresMemoryStore` implements it, exposed via
 * `memoryEngine.integrations`.
 */
import type { IntegrationConfigRecord, IntegrationConfigInput, IntegrationKind, ResolvedIntegration } from "./types.js";

export interface IntegrationStore {
  listIntegrationConfigs(orgId: string, kind?: IntegrationKind): Promise<IntegrationConfigRecord[]>;
  getIntegrationConfig(id: string): Promise<IntegrationConfigRecord | null>;
  createIntegrationConfig(orgId: string, input: IntegrationConfigInput, createdBy?: string): Promise<IntegrationConfigRecord>;
  updateIntegrationConfig(id: string, patch: Partial<IntegrationConfigInput>): Promise<IntegrationConfigRecord | null>;
  deleteIntegrationConfig(id: string): Promise<void>;
  /** Decrypted default integration for (org, kind), or null when none. */
  getResolvedIntegration(orgId: string, kind: IntegrationKind): Promise<ResolvedIntegration | null>;
  /** ADR-010 P6b — resolve tenant + decrypted integration from a GitHub App
   *  installation id (the webhook ingress routing key). */
  findIntegrationByInstallation(kind: IntegrationKind, installationId: string): Promise<(ResolvedIntegration & { orgId: string }) | null>;
}
