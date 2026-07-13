/**
 * ProviderStore — the DB-backed provider-config surface (ADR-010 P2). Backend-
 * local (like TenancyStore); `PostgresMemoryStore` implements it, surfaced via
 * `memoryEngine.providers`.
 */
import type {
  ProviderConfigRecord,
  ProviderConfigInput,
  ProviderKind,
  ResolvedProviderConfig,
} from "./types.js";

export interface ProviderStore {
  listProviderConfigs(orgId: string, kind?: ProviderKind): Promise<ProviderConfigRecord[]>;
  getProviderConfig(id: string): Promise<ProviderConfigRecord | null>;
  createProviderConfig(orgId: string, input: ProviderConfigInput, createdBy?: string): Promise<ProviderConfigRecord>;
  updateProviderConfig(id: string, patch: Partial<ProviderConfigInput>): Promise<ProviderConfigRecord | null>;
  deleteProviderConfig(id: string): Promise<void>;
  setDefaultProvider(orgId: string, kind: ProviderKind, id: string): Promise<void>;
  /** Decrypted default provider for (org, kind), or null when none is configured. */
  getDefaultResolvedProvider(orgId: string, kind: ProviderKind): Promise<ResolvedProviderConfig | null>;
  /** Resolve one named config for a role assignment; callers must still enforce org scope. */
  getResolvedProvider(id: string): Promise<ResolvedProviderConfig | null>;
}
