import type { AccessMode } from '../../exec/policy/execPolicy.js';
import { extensionToolEntries, requiredExtensionToolNames } from '../../extension/registry.js';
import { ensureRequiredCoreToolsRegistered } from '../../extension/builtin/capabilities.js';
import { MCP_DISCOVERY_TOOLS, WORKER_THREAD_TOOLS } from '../../extension/builtin/toolCatalog.js';

export interface LocalToolEntry {
  name: string;
  accessTier: AccessMode;
  actionKind: import('../../exec/policy/execPolicy.js').ActionKind;
  parallelSafe: boolean;
  availability?: 'result-cache' | 'active-workflow' | 'active-orchestration-plan' | 'root-agent' | 'computer-use' | 'browser-use' | 'terminal-use' | 'multi-profile' | 'mcp-discovery';
  advertised?: boolean;
  runtimePort?: 'orchestration' | 'browser-control' | 'session-input';
  /** Explicitly include an otherwise non-mutating action (for example browser navigation) in policy audit events. */
  audited?: boolean;
  workflowLaunch?: boolean;
  afterInvoke?: 'track-automation' | 'goal-reconcile' | 'plan-update';
  childAccessPolicy?: 'single' | 'batch';
  dynamicNamePrefix?: string;
}

const TIER_RANK: Record<AccessMode, number> = { read: 0, write: 1, shell: 2 };

/** The effective catalog is extension-owned, including every required core capability. */
export function effectiveToolRegistry(): LocalToolEntry[] {
  ensureRequiredCoreToolsRegistered();
  return extensionToolEntries();
}

export function registryAllowedTools(mode: AccessMode): Set<string> {
  const ceiling = TIER_RANK[mode];
  return new Set(effectiveToolRegistry().filter((tool) => TIER_RANK[tool.accessTier] <= ceiling).map((tool) => tool.name));
}

export function registryParallelSafeLocal(): Set<string> {
  return new Set(effectiveToolRegistry().filter((tool) => tool.parallelSafe).map((tool) => tool.name));
}

export function registryEntry(name: string): LocalToolEntry | undefined {
  const tools = effectiveToolRegistry();
  return tools.find((tool) => tool.name === name)
    ?? tools.find((tool) => tool.dynamicNamePrefix && name.startsWith(tool.dynamicNamePrefix));
}

export function isRegisteredLocalTool(name: string): boolean {
  return registryEntry(name) !== undefined;
}

export function registryToolAllowed(name: string, mode: AccessMode): boolean {
  const entry = registryEntry(name);
  return Boolean(entry && TIER_RANK[entry.accessTier] <= TIER_RANK[mode]);
}

export function registryToolParallelSafe(name: string): boolean {
  return registryEntry(name)?.parallelSafe === true;
}

/** True only for orchestration tools whose successful call accepts new work. */
export function registryDelegationLaunchTool(name: string): boolean {
  const entry = registryEntry(name);
  return Boolean(entry?.childAccessPolicy || entry?.workflowLaunch);
}

export function hideWorkerToolsFor(depth: number, tier?: string): boolean {
  return depth > 0 || tier === 'worker';
}

export function requiredCoreToolNames(): ReadonlySet<string> {
  ensureRequiredCoreToolsRegistered();
  return requiredExtensionToolNames();
}

export { MCP_DISCOVERY_TOOLS, WORKER_THREAD_TOOLS };
