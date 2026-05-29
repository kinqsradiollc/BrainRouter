import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// MAS-P5-T4: enabled packs contribute agent defs as their own tier.
import { listPacks } from './packs.js';
import { readPackState, isPackEnabled } from '../state/packStore.js';

export type Tier = 'chat' | 'reasoning' | 'worker';
export type AccessMode = 'read' | 'write' | 'shell';

export interface AgentDefinition {
  id: string;
  displayName: string;
  whenToUse: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  defaultAccess: AccessMode;
  toolScope: { local: string[]; mcp: string[] };
  disallowedTools: string[];
  maxIterations: number;
  timeoutMs: number;
  maxResultChars: number;
  subagents: string[];
  delegateName: string;
  tier: Tier;
  outputContract: unknown;
}

export type DefinitionSource = 'builtin' | 'pack' | 'user' | 'workspace';

export interface LoadedDefinition {
  def: AgentDefinition;
  source: DefinitionSource;
  filePath: string;
}

// Resolved at import time from dist/orchestration/agentRegistry.js → ../../agents
const BUILTIN_AGENTS_DIR = fileURLToPath(new URL('../../agents', import.meta.url));

function getUserAgentsDir(): string {
  const home = process.env.BRAINROUTER_HOME ?? path.join(os.homedir(), '.config', 'brainrouter');
  return path.join(home, 'agents');
}

function getWorkspaceAgentsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'agents');
}

function loadFromDir(dir: string, source: DefinitionSource): LoadedDefinition[] {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const results: LoadedDefinition[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const def = JSON.parse(raw) as AgentDefinition;
      if (!def.id || typeof def.id !== 'string') {
        console.error(`[agentRegistry] Skipping ${filePath}: missing or invalid "id" field.`);
        continue;
      }
      results.push({ def, source, filePath });
    } catch (err) {
      console.error(`[agentRegistry] Skipping ${filePath}: ${(err as Error).message}`);
    }
  }
  return results;
}

/**
 * Load all agent definitions from three tiers (builtin → user-global → workspace).
 * Same `id` from a higher-priority source wins; distinct ids coexist.
 */
/** MAS-P5-T4: agent defs contributed by enabled packs (resolved tiers). */
function loadEnabledPackAgents(workspaceRoot?: string): LoadedDefinition[] {
  try {
    const enabled = workspaceRoot ? readPackState(workspaceRoot).enabled : [];
    if (enabled.length === 0) return [];
    return listPacks(workspaceRoot)
      .filter((p) => isPackEnabled(enabled, p.name))
      .flatMap((p) => loadFromDir(p.agentsDir, 'pack'));
  } catch {
    return [];
  }
}

export function loadRegistry(workspaceRoot?: string): LoadedDefinition[] {
  const builtin = loadFromDir(BUILTIN_AGENTS_DIR, 'builtin');
  const packs = loadEnabledPackAgents(workspaceRoot);
  const user = loadFromDir(getUserAgentsDir(), 'user');
  const workspace = workspaceRoot
    ? loadFromDir(getWorkspaceAgentsDir(workspaceRoot), 'workspace')
    : [];

  // Precedence: builtin (lowest) → pack → user → workspace (highest).
  // Same `id` from a higher tier wins; distinct ids coexist.
  const merged = new Map<string, LoadedDefinition>();
  for (const loaded of [...builtin, ...packs, ...user, ...workspace]) {
    merged.set(loaded.def.id, loaded);
  }
  return Array.from(merged.values());
}

export function findById(id: string, workspaceRoot?: string): LoadedDefinition | undefined {
  return loadRegistry(workspaceRoot).find((l) => l.def.id === id);
}

export function listAll(workspaceRoot?: string): LoadedDefinition[] {
  return loadRegistry(workspaceRoot);
}
