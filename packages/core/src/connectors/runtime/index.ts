// Connector runtime orchestration: the shared per-source checkpoint runner that
// drives ingest → memory for both the desktop host and the chat/CLI/MCP agent.
export * from './runCheckpoint.js';
export type { ConnectorRuntimeHost } from './host/contracts.js';
