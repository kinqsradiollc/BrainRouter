/**
 * ADR-016 C2 — ConnectorStore: per-USER connector config + sealed OAuth token,
 * plus the per-ORG OAuth *app* credentials the broker uses. Backend-local;
 * `PostgresMemoryStore` implements it, exposed via `memoryEngine.connectors`.
 */

export interface ConnectorTokenSecret {
  accessToken: string;
  refreshToken?: string;
  /** ISO expiry; absent = non-expiring (e.g. a GitHub OAuth-App token). */
  expiresAt?: string;
  scope?: string;
  /** Exact callback used for providers (notably GitLab) that require it again
   * during refresh-token rotation. */
  redirectUri?: string;
}

export type ConnectorVisibility = "private" | "org";

export interface ConnectorConfigRecord {
  id: string;
  userId: string;
  orgId: string | null;
  source: string;
  name: string;
  status: string;
  enabled: boolean;
  visibility: ConnectorVisibility;
  config: Record<string, unknown>;
  /** Whether a sealed credential is stored (the value is never returned here). */
  hasCredential: boolean;
  checkpoint: Record<string, unknown>;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A connector with its credential decrypted — for the sync runner only. */
export interface ResolvedConnector extends Omit<ConnectorConfigRecord, "hasCredential"> {
  credential: ConnectorTokenSecret | null;
}

export interface ConnectorConfigInput {
  source: string;
  name?: string;
  orgId?: string | null;
  visibility?: ConnectorVisibility;
  enabled?: boolean;
  config?: Record<string, unknown>;
  credential?: ConnectorTokenSecret;
}

export interface ConnectorConfigPatch extends Omit<Partial<ConnectorConfigInput>, "credential"> {
  /** `null` explicitly removes a sealed credential (disconnect); omitted leaves it unchanged. */
  credential?: ConnectorTokenSecret | null;
  status?: string;
  checkpoint?: Record<string, unknown>;
  lastRunAt?: string;
  lastError?: string | null;
}

export interface OAuthAppConfig {
  id: string;
  orgId: string;
  source: string;
  clientId: string;
  scopes: string;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedOAuthApp {
  orgId: string;
  source: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

export interface ConnectorStore {
  listConnectors(userId: string): Promise<ConnectorConfigRecord[]>;
  getConnector(id: string): Promise<ConnectorConfigRecord | null>;
  /** Decrypted credential — sync runner / OAuth callback only. */
  getResolvedConnector(id: string): Promise<ResolvedConnector | null>;
  createConnector(userId: string, input: ConnectorConfigInput): Promise<ConnectorConfigRecord>;
  updateConnector(id: string, patch: ConnectorConfigPatch): Promise<ConnectorConfigRecord | null>;
  deleteConnector(id: string): Promise<void>;
  /** All connectors due for a sync (enabled) across all users — the runner's feed. */
  listAllEnabledConnectors(): Promise<ConnectorConfigRecord[]>;

  // ── per-org OAuth app credentials (the broker's client_id/secret) ──
  getResolvedOAuthApp(orgId: string, source: string): Promise<ResolvedOAuthApp | null>;
  upsertOAuthApp(orgId: string, source: string, clientId: string, clientSecret: string | undefined, scopes?: string): Promise<OAuthAppConfig>;
}
