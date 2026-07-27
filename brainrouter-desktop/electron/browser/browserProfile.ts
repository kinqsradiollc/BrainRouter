import { createHash } from 'node:crypto';
import path from 'node:path';

const BROWSER_PARTITION_BASE = 'persist:brainrouter-browser';

/**
 * Use one durable browser profile per workspace. Chat sessions share the
 * workspace's cookies, storage, cache, and login/challenge continuity while
 * different workspaces remain isolated.
 */
export function browserPartitionForWorkspace(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot || '.');
  const key = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `${BROWSER_PARTITION_BASE}-${key}`;
}
