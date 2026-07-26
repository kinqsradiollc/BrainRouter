/**
 * W4b executable agent-definition registry.
 *
 * `loadRegistry` is the complete precedence-resolved inventory used by catalog
 * and golden tests. Runtime consumers use `loadActiveRegistry`, `listAll`, and
 * `findById`: once a workspace manifest exists, those surfaces expose only the
 * orchestration roles available under its explicit mode/allow/deny policy.
 * Missing or unreadable manifests deliberately preserve the legacy registry
 * byte-for-byte.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// MAS-P5-T4: enabled packs contribute agent defs as their own tier.
import { listPacks } from '../../pack/packs.js';
import { readPackState, isPackEnabled } from '../../pack/packStore.js';
import { loadWorkspaceManifest } from '../../workspace/manifest.js';
import {
  listAgentDefinitionFiles,
  readAgentDefinitionFile,
  type AgentDefinition,
} from './agentDefinitionFile.js';

export type { AccessMode, AgentDefinition, Tier } from './agentDefinitionFile.js';
export { AGENT_DEFINITION_MAX_BYTES, parseAgentDefinition } from './agentDefinitionFile.js';

export type DefinitionSource = 'builtin' | 'pack' | 'user' | 'workspace';

export interface LoadedDefinition {
  def: AgentDefinition;
  source: DefinitionSource;
  filePath: string;
}

// Resolved at import time from dist/orchestration/agents/agentRegistry.js → ../../../agents
const BUILTIN_AGENTS_DIR = fileURLToPath(new URL('../../../agents', import.meta.url));

function getUserAgentsDir(): string {
  const home = process.env.BRAINROUTER_HOME ?? path.join(os.homedir(), '.config', 'brainrouter');
  return path.join(home, 'agents');
}

function getWorkspaceAgentsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'agents');
}

function loadFromDir(
  dir: string,
  source: DefinitionSource,
  boundaryRoot = dir,
  containmentRoot = boundaryRoot,
): LoadedDefinition[] {
  const results: LoadedDefinition[] = [];
  for (const filePath of listAgentDefinitionFiles(dir, boundaryRoot, containmentRoot)) {
    try {
      const def = readAgentDefinitionFile(filePath, boundaryRoot, containmentRoot);
      results.push({ def, source, filePath });
    } catch (err) {
      console.error(`[agentRegistry] Skipping ${filePath}: ${(err as Error).message}`);
    }
  }
  return results;
}

/**
 * Load all agent definitions from four tiers (builtin → pack → user-global → workspace).
 * Same `id` from a higher-priority source wins; distinct ids coexist.
 */
/** MAS-P5-T4: agent defs contributed by enabled packs (resolved tiers). */
function loadEnabledPackAgents(workspaceRoot?: string): LoadedDefinition[] {
  try {
    const enabled = workspaceRoot ? readPackState(workspaceRoot).enabled : [];
    if (enabled.length === 0) return [];
    return listPacks(workspaceRoot)
      .filter((p) => isPackEnabled(enabled, p.name))
      .flatMap((p) => {
        const sourceRoot = p.source === 'workspace' && workspaceRoot
          ? workspaceRoot
          : p.source === 'user'
            ? path.dirname(path.dirname(p.dir))
            : path.dirname(p.dir);
        return loadFromDir(p.agentsDir, 'pack', sourceRoot, p.dir);
      });
  } catch {
    return [];
  }
}

export function loadRegistry(workspaceRoot?: string): LoadedDefinition[] {
  const builtin = loadFromDir(BUILTIN_AGENTS_DIR, 'builtin');
  const packs = loadEnabledPackAgents(workspaceRoot);
  const userAgentsDir = getUserAgentsDir();
  const user = loadFromDir(userAgentsDir, 'user', path.dirname(userAgentsDir));
  const workspace = workspaceRoot
    ? loadFromDir(getWorkspaceAgentsDir(workspaceRoot), 'workspace', workspaceRoot)
    : [];

  // Precedence: builtin (lowest) → pack → user → workspace (highest).
  // Same `id` from a higher tier wins; distinct ids coexist.
  const merged = new Map<string, LoadedDefinition>();
  for (const loaded of [...builtin, ...packs, ...user, ...workspace]) {
    merged.set(loaded.def.id, loaded);
  }
  return Array.from(merged.values());
}

/** Return the definitions that may be surfaced or executed in this workspace. */
export function loadActiveRegistry(workspaceRoot?: string): LoadedDefinition[] {
  const registry = loadRegistry(workspaceRoot);
  if (!workspaceRoot) return registry;

  const manifest = loadWorkspaceManifest(workspaceRoot);
  if (!manifest) return registry;

  if (manifest.orchestration.mode === 'off') return [];
  const disabledIds = new Set(manifest.orchestration.disabledRoles);
  const activeIds = new Set(
    manifest.orchestration.availableRoles.filter((id) => !disabledIds.has(id)),
  );
  return registry.filter((loaded) => activeIds.has(loaded.def.id));
}

export function findById(id: string, workspaceRoot?: string): LoadedDefinition | undefined {
  return loadActiveRegistry(workspaceRoot).find((l) => l.def.id === id);
}

export function listAll(workspaceRoot?: string): LoadedDefinition[] {
  return loadActiveRegistry(workspaceRoot);
}
