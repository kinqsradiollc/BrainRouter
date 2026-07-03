import type {
  ConnectorDefinition,
  ConnectorDefinitionBundle,
  ConnectorRecord,
} from '@kinqs/brainrouter-types';
import { createConnector, listConnectors } from './stores/connectorStore.js';

export function exportConnectorDefinitions(
  workspaceRoot: string,
  options?: { connectorIds?: string[]; now?: string },
): ConnectorDefinitionBundle {
  const ids = new Set(options?.connectorIds?.filter(Boolean) ?? []);
  const connectors = listConnectors(workspaceRoot)
    .filter((connector) => ids.size === 0 || ids.has(connector.id))
    .map(toDefinition);
  return {
    schemaVersion: 1,
    exportedAt: options?.now ?? new Date().toISOString(),
    connectors,
  };
}

export function importConnectorDefinitions(
  workspaceRoot: string,
  input: ConnectorDefinitionBundle | ConnectorDefinition[] | string,
): ConnectorRecord[] {
  const bundle = parseBundle(input);
  return bundle.connectors.map((definition) => createConnector(workspaceRoot, {
    source: definition.source,
    name: definition.name,
    description: definition.description,
    config: { ...definition.config },
    credential: { ...definition.credential },
    flows: [...definition.flows],
  }));
}

function toDefinition(connector: ConnectorRecord): ConnectorDefinition {
  const definition: ConnectorDefinition = {
    source: connector.source,
    name: connector.name,
    config: { ...connector.config },
    credential: {
      mode: connector.credential.mode,
      ref: connector.credential.ref,
      label: connector.credential.label,
      hasSecret: connector.credential.hasSecret,
    },
    flows: [...connector.flows],
  };
  if (connector.description) definition.description = connector.description;
  return definition;
}

function parseBundle(input: ConnectorDefinitionBundle | ConnectorDefinition[] | string): ConnectorDefinitionBundle {
  const parsed = typeof input === 'string' ? JSON.parse(input) as ConnectorDefinitionBundle | ConnectorDefinition[] : input;
  const bundle = Array.isArray(parsed)
    ? { schemaVersion: 1 as const, exportedAt: new Date().toISOString(), connectors: parsed }
    : parsed;
  if (bundle?.schemaVersion !== 1) throw new Error('Unsupported connector definition bundle version.');
  if (!Array.isArray(bundle.connectors)) throw new Error('Connector definition bundle must contain connectors.');
  return bundle;
}
