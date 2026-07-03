import type { ConnectorCheckpoint, ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';

export interface McpConnectorResource {
  server?: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpConnectorContent {
  uri?: string;
  text?: string;
  blob?: string;
  mimeType?: string;
}

export interface McpConnectorReadResult {
  contents?: McpConnectorContent[];
}

export interface McpConnectorClient {
  listResources(opts: { serverId?: string; resourceUris?: string[]; limit?: number }): Promise<McpConnectorResource[]>;
  readResource(resource: McpConnectorResource): Promise<McpConnectorReadResult>;
}

export interface McpConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export async function runMcpConnectorCheckpoint(
  connector: ConnectorRecord,
  client: McpConnectorClient,
  options?: { now?: string; maxResources?: number },
): Promise<McpConnectorRunResult> {
  if (connector.source !== 'mcp') throw new Error(`Connector source ${connector.source} is not mcp.`);
  const serverId = configString(connector, 'serverId') || undefined;
  const resourceUris = configStringList(connector, 'resourceUris');
  const maxResources = Math.max(1, Math.min(500, Math.floor(options?.maxResources ?? 100)));
  const now = options?.now ?? new Date().toISOString();
  const resources = await client.listResources({ serverId, resourceUris, limit: maxResources });
  const documents: ConnectorDocument[] = [];
  const failures: string[] = [];

  for (const resource of resources.slice(0, maxResources)) {
    try {
      const result = await client.readResource(resource);
      const doc = mcpResourceDocument(connector, resource, result);
      if (doc.text.trim()) documents.push(doc);
    } catch (err) {
      failures.push(`${resource.server ? `${resource.server}:` : ''}${resource.uri}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (resources.length > maxResources) failures.push(`Stopped after ${maxResources} MCP resources.`);

  return {
    documents,
    failures,
    checkpoint: {
      completedAt: now,
      documentCount: documents.length,
      failureCount: failures.length,
      resourceCount: resources.length,
      servers: unique(resources.map((r) => r.server).filter((v): v is string => !!v)),
    },
  };
}

function mcpResourceDocument(connector: ConnectorRecord, resource: McpConnectorResource, result: McpConnectorReadResult): ConnectorDocument {
  const contents = result.contents ?? [];
  const text = contents
    .map((content) => content.text ?? (content.blob ? `[binary resource ${content.mimeType ?? 'application/octet-stream'}]` : ''))
    .filter(Boolean)
    .join('\n\n');
  const title = resource.name || resource.uri;
  return {
    id: `mcp:${connector.id}:${resource.server ?? 'server'}:${resource.uri}`,
    connectorId: connector.id,
    source: 'mcp',
    kind: 'file',
    repository: resource.server,
    title,
    updatedAt: undefined,
    text: [resource.description, text].filter(Boolean).join('\n\n'),
    metadata: {
      server: resource.server,
      uri: resource.uri,
      mimeType: resource.mimeType,
      contents: contents.map((content) => ({ uri: content.uri, mimeType: content.mimeType, hasBlob: !!content.blob })),
    },
  };
}

function configString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function configStringList(connector: ConnectorRecord, key: string): string[] {
  const value = connector.config[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) seen.add(value);
  return [...seen];
}
