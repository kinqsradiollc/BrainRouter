/**
 * Provider config records (ADR-010 P2). Mirrors the desktop/CLI
 * `LLMConfig`/`ProviderDefinition` shape so the setup is identical, plus the
 * backend service `kind`.
 */

/** The four backend AI service roles a provider config can back. */
export type ProviderKind = "llm" | "embedding" | "reranker" | "judge";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["llm", "embedding", "reranker", "judge"];

export function isProviderKind(x: unknown): x is ProviderKind {
  return typeof x === "string" && (PROVIDER_KINDS as readonly string[]).includes(x);
}

/** A stored provider config as surfaced to the admin API — NEVER carries the key. */
export interface ProviderConfigRecord {
  id: string;
  orgId: string;
  kind: ProviderKind;
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  models: string[];
  wireFormat: string;
  reasoningEffort: string;
  extra: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
  /** True when an API key is stored (the key itself is never returned). */
  hasKey: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted on create/update. `apiKey` is PLAINTEXT in; it is sealed at rest. */
export interface ProviderConfigInput {
  kind: ProviderKind;
  providerId?: string;
  label?: string;
  baseUrl?: string;
  /** Plaintext key; omit to leave an existing key unchanged (on update). */
  apiKey?: string;
  model?: string;
  models?: string[];
  wireFormat?: string;
  reasoningEffort?: string;
  extra?: Record<string, unknown>;
  enabled?: boolean;
  isDefault?: boolean;
}

/** A decrypted, ready-to-use provider config the runtime services consume. */
export interface ResolvedProviderConfig {
  kind: ProviderKind;
  endpoint: string;
  apiKey: string;
  model: string;
  models: string[];
  wireFormat?: string;
  reasoningEffort?: string;
  extra: Record<string, unknown>;
  /** Where it came from — a DB row or the .env fallback (for diagnostics). */
  source: "db" | "env";
}
