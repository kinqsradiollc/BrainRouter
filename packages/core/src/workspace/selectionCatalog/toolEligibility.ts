import { localToolExecutor } from '../../tool/registry/executors.js';
import { registryEntry } from '../../tool/registry/registry.js';
import { WORKSPACE_SELECTION_STABLE_ID } from './types.js';

/**
 * Exact stable tool-ID membership shared by catalog construction and runtime.
 * Dynamic aliases, internal/hidden executors, and unadvertised entries are not
 * reviewed manifest selections.
 */
export function isSelectableWorkspaceCatalogToolId(id: string): boolean {
  if (!WORKSPACE_SELECTION_STABLE_ID.test(id)) return false;
  const entry = registryEntry(id);
  if (entry?.name !== id || entry.advertised === false) return false;
  return localToolExecutor(id)?.exposure() === 'direct';
}
