import type { ConnectorPermission, ConnectorPermissionRecord } from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

type ConnectorPermissionStoreFile = Record<string, ConnectorPermissionRecord>;

function permissionsFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'connector-permissions.json');
}

function readAll(workspaceRoot: string): ConnectorPermissionStoreFile {
  return readJsonFile<ConnectorPermissionStoreFile>(permissionsFile(workspaceRoot), {});
}

function writeAll(workspaceRoot: string, store: ConnectorPermissionStoreFile): void {
  writeJsonFile(permissionsFile(workspaceRoot), store);
}

export interface ConnectorPermissionFilter {
  connectorId?: string;
  principalId?: string;
  repository?: string;
}

export function upsertConnectorPermissions(
  workspaceRoot: string,
  permissions: ConnectorPermission[],
  options?: { now?: string },
): ConnectorPermissionRecord[] {
  if (permissions.length === 0) return [];
  const store = readAll(workspaceRoot);
  const now = options?.now ?? new Date().toISOString();
  const upserted: ConnectorPermissionRecord[] = [];
  for (const permission of permissions) {
    const existing = store[permission.id];
    const record: ConnectorPermissionRecord = {
      ...permission,
      repositories: permission.repositories ? [...permission.repositories] : undefined,
      metadata: { ...permission.metadata },
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    store[permission.id] = record;
    upserted.push(record);
  }
  writeAll(workspaceRoot, store);
  return upserted;
}

export function listConnectorPermissions(
  workspaceRoot: string,
  filter?: ConnectorPermissionFilter,
): ConnectorPermissionRecord[] {
  return Object.values(readAll(workspaceRoot))
    .filter((permission) => matchesFilter(permission, filter))
    .sort((a, b) => a.principalId.localeCompare(b.principalId) || a.role.localeCompare(b.role));
}

export function countConnectorPermissions(workspaceRoot: string, filter?: ConnectorPermissionFilter): number {
  return listConnectorPermissions(workspaceRoot, filter).length;
}

export function deleteConnectorPermissions(workspaceRoot: string, connectorId: string): number {
  const store = readAll(workspaceRoot);
  let deleted = 0;
  for (const [id, permission] of Object.entries(store)) {
    if (permission.connectorId !== connectorId) continue;
    delete store[id];
    deleted++;
  }
  if (deleted > 0) writeAll(workspaceRoot, store);
  return deleted;
}

function matchesFilter(permission: ConnectorPermissionRecord, filter?: ConnectorPermissionFilter): boolean {
  if (filter?.connectorId && permission.connectorId !== filter.connectorId) return false;
  if (filter?.principalId && permission.principalId !== filter.principalId) return false;
  if (filter?.repository && !(permission.repositories ?? []).includes(filter.repository)) return false;
  return true;
}
