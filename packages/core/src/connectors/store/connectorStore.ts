import { randomUUID } from 'node:crypto';
import type {
  ConnectorCheckpoint,
  ConnectorConfig,
  ConnectorCredentialRef,
  ConnectorFlow,
  ConnectorRecord,
  ConnectorRunRecord,
  ConnectorRunStatus,
  ConnectorSource,
  ConnectorStatus,
} from '@kinqs/brainrouter-types';
import { isConnectorFlow, isConnectorSource } from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import { connectorSupportsFlow, getConnectorCatalogEntry } from '../catalog.js';
import { deleteConnectorDocuments } from './documentStore.js';
import { deleteConnectorPermissions } from './permissionStore.js';

interface ConnectorStoreFile {
  connectors: Record<string, ConnectorRecord>;
  runs: Record<string, ConnectorRunRecord[]>;
}

function emptyStore(): ConnectorStoreFile {
  return { connectors: {}, runs: {} };
}

function connectorsFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'connectors.json');
}

function readStore(workspaceRoot: string): ConnectorStoreFile {
  const data = readJsonFile<ConnectorStoreFile>(connectorsFile(workspaceRoot), emptyStore());
  return {
    connectors: data.connectors ?? {},
    runs: data.runs ?? {},
  };
}

function writeStore(workspaceRoot: string, store: ConnectorStoreFile): void {
  writeJsonFile(connectorsFile(workspaceRoot), store);
}

export interface CreateConnectorInput {
  source: ConnectorSource;
  name: string;
  description?: string;
  config?: ConnectorConfig;
  credential?: ConnectorCredentialRef;
  flows?: ConnectorFlow[];
  status?: ConnectorStatus;
}

export type ConnectorPatch = Partial<
  Omit<ConnectorRecord, 'id' | 'source' | 'workspaceRoot' | 'createdAt' | 'updatedAt'>
>;

export interface ConnectorFilter {
  source?: ConnectorSource;
  status?: ConnectorStatus;
}

export interface RecordConnectorRunInput {
  connectorId: string;
  flow: ConnectorFlow;
  status: ConnectorRunStatus;
  startedAt?: string;
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

export type FinishConnectorRunInput = Partial<
  Pick<RecordConnectorRunInput,
    'documentsSeen' | 'documentsIndexed' | 'permissionsSeen' | 'permissionsIndexed' |
    'failures' | 'error' | 'checkpointAfter'
  >
> & {
  status: ConnectorRunStatus;
  completedAt?: string;
};

export function readConnectorsAll(workspaceRoot: string): Record<string, ConnectorRecord> {
  return readStore(workspaceRoot).connectors;
}

export function listConnectors(workspaceRoot: string, filter?: ConnectorFilter): ConnectorRecord[] {
  return Object.values(readConnectorsAll(workspaceRoot))
    .filter((connector) => {
      if (filter?.source && connector.source !== filter.source) return false;
      if (filter?.status && connector.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getConnector(workspaceRoot: string, id: string): ConnectorRecord | undefined {
  return readConnectorsAll(workspaceRoot)[id];
}

export function createConnector(workspaceRoot: string, input: CreateConnectorInput): ConnectorRecord {
  validateSource(input.source);
  const name = input.name?.trim();
  if (!name) throw new Error('Connector name must be a non-empty string.');

  const catalog = getConnectorCatalogEntry(input.source);
  if (!catalog) throw new Error(`Unsupported connector source: ${input.source}`);

  const flows = normalizeFlows(input.flows ?? catalog.flows, input.source);
  const now = new Date().toISOString();
  const id = `conn_${randomUUID().slice(0, 8)}`;
  const record: ConnectorRecord = {
    id,
    source: input.source,
    name,
    status: input.status ?? 'active',
    config: { ...(input.config ?? {}) },
    credential: input.credential ? { ...input.credential } : { mode: 'none' },
    flows,
    workspaceRoot,
    createdAt: now,
    updatedAt: now,
  };
  const description = input.description?.trim();
  if (description) record.description = description;

  const store = readStore(workspaceRoot);
  store.connectors[id] = record;
  store.runs[id] = [];
  writeStore(workspaceRoot, store);
  return record;
}

export function updateConnector(
  workspaceRoot: string,
  id: string,
  patch: ConnectorPatch,
): ConnectorRecord | undefined {
  const store = readStore(workspaceRoot);
  const existing = store.connectors[id];
  if (!existing) return undefined;

  const flows = patch.flows ? normalizeFlows(patch.flows, existing.source) : existing.flows;
  const next: ConnectorRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    source: existing.source,
    workspaceRoot: existing.workspaceRoot,
    createdAt: existing.createdAt,
    flows,
    config: patch.config ? { ...patch.config } : existing.config,
    credential: patch.credential ? { ...patch.credential } : existing.credential,
    updatedAt: new Date().toISOString(),
  };
  if (!next.name.trim()) throw new Error('Connector name must be a non-empty string.');

  store.connectors[id] = next;
  writeStore(workspaceRoot, store);
  return next;
}

export function setConnectorStatus(
  workspaceRoot: string,
  id: string,
  status: ConnectorStatus,
  lastError?: string,
): ConnectorRecord | undefined {
  return updateConnector(workspaceRoot, id, { status, lastError });
}

export function deleteConnector(workspaceRoot: string, id: string): boolean {
  const store = readStore(workspaceRoot);
  if (!store.connectors[id]) return false;
  delete store.connectors[id];
  delete store.runs[id];
  writeStore(workspaceRoot, store);
  deleteConnectorDocuments(workspaceRoot, id);
  deleteConnectorPermissions(workspaceRoot, id);
  return true;
}

export function recordConnectorRun(
  workspaceRoot: string,
  input: RecordConnectorRunInput,
): ConnectorRunRecord {
  const store = readStore(workspaceRoot);
  const connector = store.connectors[input.connectorId];
  if (!connector) throw new Error(`Connector not found: ${input.connectorId}`);
  if (!connectorSupportsFlow(connector.source, input.flow)) {
    throw new Error(`Connector source ${connector.source} does not support flow ${input.flow}.`);
  }

  const startedAt = input.startedAt ?? new Date().toISOString();
  const completedAt = input.completedAt ?? (isTerminalRunStatus(input.status) ? new Date().toISOString() : undefined);
  const run: ConnectorRunRecord = {
    id: `crun_${randomUUID().slice(0, 8)}`,
    connectorId: input.connectorId,
    source: connector.source,
    flow: input.flow,
    status: input.status,
    startedAt,
  };
  if (completedAt) run.completedAt = completedAt;
  if (input.documentsSeen !== undefined) run.documentsSeen = input.documentsSeen;
  if (input.documentsIndexed !== undefined) run.documentsIndexed = input.documentsIndexed;
  if (input.permissionsSeen !== undefined) run.permissionsSeen = input.permissionsSeen;
  if (input.permissionsIndexed !== undefined) run.permissionsIndexed = input.permissionsIndexed;
  if (input.failures !== undefined) run.failures = input.failures;
  if (input.error) run.error = input.error;
  if (input.checkpointBefore) run.checkpointBefore = { ...input.checkpointBefore };
  if (input.checkpointAfter) run.checkpointAfter = { ...input.checkpointAfter };

  store.runs[input.connectorId] = [run, ...(store.runs[input.connectorId] ?? [])];
  const nextConnector: ConnectorRecord = {
    ...connector,
    lastRunAt: startedAt,
    updatedAt: new Date().toISOString(),
  };
  if (input.status === 'succeeded') {
    nextConnector.status = 'active';
    nextConnector.lastSuccessAt = completedAt ?? startedAt;
    delete nextConnector.lastError;
    if (input.checkpointAfter) nextConnector.checkpoint = { ...input.checkpointAfter };
  } else if (input.status === 'failed') {
    nextConnector.status = 'error';
    nextConnector.lastError = input.error ?? 'Connector run failed.';
  }
  store.connectors[input.connectorId] = nextConnector;
  writeStore(workspaceRoot, store);
  return run;
}

export function finishConnectorRun(
  workspaceRoot: string,
  connectorId: string,
  runId: string,
  input: FinishConnectorRunInput,
): ConnectorRunRecord | undefined {
  const store = readStore(workspaceRoot);
  const connector = store.connectors[connectorId];
  const runs = store.runs[connectorId] ?? [];
  const index = runs.findIndex((run) => run.id === runId);
  if (!connector || index < 0) return undefined;

  const completedAt = input.completedAt ?? (isTerminalRunStatus(input.status) ? new Date().toISOString() : undefined);
  const run: ConnectorRunRecord = {
    ...runs[index],
    status: input.status,
  };
  if (completedAt) run.completedAt = completedAt;
  if (input.documentsSeen !== undefined) run.documentsSeen = input.documentsSeen;
  if (input.documentsIndexed !== undefined) run.documentsIndexed = input.documentsIndexed;
  if (input.permissionsSeen !== undefined) run.permissionsSeen = input.permissionsSeen;
  if (input.permissionsIndexed !== undefined) run.permissionsIndexed = input.permissionsIndexed;
  if (input.failures !== undefined) run.failures = input.failures;
  if (input.error) run.error = input.error;
  else if (input.status === 'succeeded') delete run.error;
  if (input.checkpointAfter) run.checkpointAfter = { ...input.checkpointAfter };
  runs[index] = run;

  const nextConnector: ConnectorRecord = {
    ...connector,
    lastRunAt: run.startedAt,
    updatedAt: new Date().toISOString(),
  };
  if (input.status === 'succeeded') {
    nextConnector.status = 'active';
    nextConnector.lastSuccessAt = completedAt ?? run.startedAt;
    delete nextConnector.lastError;
    if (input.checkpointAfter) nextConnector.checkpoint = { ...input.checkpointAfter };
  } else if (input.status === 'failed') {
    nextConnector.status = 'error';
    nextConnector.lastError = input.error ?? 'Connector run failed.';
  }
  store.connectors[connectorId] = nextConnector;
  store.runs[connectorId] = runs;
  writeStore(workspaceRoot, store);
  return run;
}

export function listConnectorRuns(workspaceRoot: string, connectorId: string): ConnectorRunRecord[] {
  return [...(readStore(workspaceRoot).runs[connectorId] ?? [])];
}

function validateSource(source: ConnectorSource): void {
  if (!isConnectorSource(source)) throw new Error(`Unsupported connector source: ${String(source)}`);
}

function normalizeFlows(flows: ConnectorFlow[], source: ConnectorSource): ConnectorFlow[] {
  const unique: ConnectorFlow[] = [];
  for (const flow of flows) {
    if (!isConnectorFlow(flow)) throw new Error(`Unsupported connector flow: ${String(flow)}`);
    if (!connectorSupportsFlow(source, flow)) {
      throw new Error(`Connector source ${source} does not support flow ${flow}.`);
    }
    if (!unique.includes(flow)) unique.push(flow);
  }
  if (unique.length === 0) throw new Error('Connector must support at least one flow.');
  return unique;
}

function isTerminalRunStatus(status: ConnectorRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
