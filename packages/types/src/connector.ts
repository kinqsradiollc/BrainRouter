/**
 * BrainRouter Connectors — shared dependency-free contracts.
 *
 * The shape mirrors the useful parts of Onyx's connector model without tying
 * callers to a specific ingestion runtime: catalog entries declare sources and
 * supported flows, connector records persist workspace configuration, and run
 * records track validation/ingestion attempts plus checkpoints.
 */

export type ConnectorSource =
  | "github"
  | "gitlab"
  | "slack"
  | "google-drive"
  | "confluence"
  | "jira"
  | "filesystem"
  | "web"
  | "mcp";

export const CONNECTOR_SOURCES: readonly ConnectorSource[] = [
  "github",
  "gitlab",
  "slack",
  "google-drive",
  "confluence",
  "jira",
  "filesystem",
  "web",
  "mcp",
];

export type ConnectorFlow =
  | "load"
  | "poll"
  | "checkpoint"
  | "slim"
  | "event"
  | "permission-sync";

export const CONNECTOR_FLOWS: readonly ConnectorFlow[] = [
  "load",
  "poll",
  "checkpoint",
  "slim",
  "event",
  "permission-sync",
];

export type ConnectorCredentialMode = "none" | "static" | "dynamic" | "oauth";

export type ConnectorStatus = "active" | "paused" | "error" | "deleting";

export type ConnectorRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ConnectorConfigValue = string | number | boolean | null | string[];
export type ConnectorConfig = Record<string, ConnectorConfigValue>;
export type ConnectorCheckpoint = Record<string, unknown>;
export type ConnectorDocumentKind = "issue" | "pull-request" | "file";
export type ConnectorPrincipalKind = "user" | "team" | "group" | "service-account" | "unknown";

export interface ConnectorFieldSpec {
  key: string;
  label: string;
  type: "string" | "boolean" | "number" | "string-list" | "secret";
  required?: boolean;
  description?: string;
  defaultValue?: ConnectorConfigValue;
}

export interface ConnectorCatalogEntry {
  source: ConnectorSource;
  title: string;
  description: string;
  flows: ConnectorFlow[];
  credentialModes: ConnectorCredentialMode[];
  configFields: ConnectorFieldSpec[];
  credentialFields: ConnectorFieldSpec[];
}

export interface ConnectorCredentialRef {
  mode: ConnectorCredentialMode;
  /** Env var, config key, keychain item label, or OAuth account id. */
  ref?: string;
  label?: string;
  hasSecret?: boolean;
}

export interface ConnectorRecord {
  id: string;
  source: ConnectorSource;
  name: string;
  description?: string;
  status: ConnectorStatus;
  config: ConnectorConfig;
  credential: ConnectorCredentialRef;
  flows: ConnectorFlow[];
  workspaceRoot: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  checkpoint?: ConnectorCheckpoint;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRunRecord {
  id: string;
  connectorId: string;
  source: ConnectorSource;
  flow: ConnectorFlow;
  status: ConnectorRunStatus;
  startedAt: string;
  completedAt?: string;
  documentsSeen?: number;
  documentsIndexed?: number;
  permissionsSeen?: number;
  permissionsIndexed?: number;
  failures?: number;
  error?: string;
  checkpointBefore?: ConnectorCheckpoint;
  checkpointAfter?: ConnectorCheckpoint;
}

export interface ConnectorDocument {
  id: string;
  connectorId: string;
  source: ConnectorSource;
  kind: ConnectorDocumentKind;
  repository?: string;
  title: string;
  url?: string;
  updatedAt?: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface ConnectorDocumentRecord extends ConnectorDocument {
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ConnectorPermission {
  id: string;
  connectorId: string;
  source: ConnectorSource;
  principalId: string;
  principalKind: ConnectorPrincipalKind;
  role: string;
  repositories?: string[];
  displayName?: string;
  url?: string;
  metadata: Record<string, unknown>;
}

export interface ConnectorPermissionRecord extends ConnectorPermission {
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ConnectorDefinition {
  source: ConnectorSource;
  name: string;
  description?: string;
  config: ConnectorConfig;
  credential: ConnectorCredentialRef;
  flows: ConnectorFlow[];
}

export interface ConnectorDefinitionBundle {
  schemaVersion: 1;
  exportedAt: string;
  connectors: ConnectorDefinition[];
}

export function isConnectorSource(x: unknown): x is ConnectorSource {
  return typeof x === "string" && (CONNECTOR_SOURCES as readonly string[]).includes(x);
}

export function isConnectorFlow(x: unknown): x is ConnectorFlow {
  return typeof x === "string" && (CONNECTOR_FLOWS as readonly string[]).includes(x);
}
