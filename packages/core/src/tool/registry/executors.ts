import type { AccessMode, ActionKind } from '../../exec/policy/execPolicy.js';
import { ensureRequiredCoreToolsRegistered, type BuiltinToolRuntimePort } from '../../extension/builtin/capabilities.js';
import { extensionExecutor, extensionExecutors } from '../../extension/registry.js';
import { registryEntry } from './registry.js';
import type { BrowserControlPort } from '../../browser/control.js';

export type ToolExposure = 'direct' | 'hidden';
export interface LocalToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface OrchestrationRuntimePort { invoke(toolName: string, args: Record<string, any>, metadata: { workflowLaunch: boolean }): Promise<string> }
export interface ToolLifecycleRuntimePort { afterInvoke(kind: 'track-automation' | 'goal-reconcile' | 'plan-update', args: Record<string, any>): void | Promise<void> }
export interface LocalToolInvocation {
  args: Record<string, any>;
  invokedName?: string;
  builtinRuntime?: BuiltinToolRuntimePort;
  orchestrationRuntime?: OrchestrationRuntimePort;
  lifecycleRuntime?: ToolLifecycleRuntimePort;
  /** Desktop-only, per-Agent port. Never copied into child/reviewer agents. */
  browserControlPort?: BrowserControlPort;
  signal?: AbortSignal;
}
export interface LocalToolAvailabilityContext {
  resultExpansionAvailable?: boolean;
  workflowActive?: boolean;
  rootAgent?: boolean;
  computerUseAvailable?: boolean;
  browserUseAvailable?: boolean;
  terminalUseAvailable?: boolean;
  multiProfile?: boolean;
  mcpDiscovery?: boolean;
}
export interface LocalToolExecutor {
  toolName(): string;
  spec(): LocalToolSpec;
  exposure(): ToolExposure;
  accessTier(): AccessMode;
  actionKind(): ActionKind;
  supportsParallelToolCalls(): boolean;
  isAvailable?(context: LocalToolAvailabilityContext): boolean;
  handle(invocation: LocalToolInvocation): Promise<string>;
}

export function localToolExecutors(): LocalToolExecutor[] {
  ensureRequiredCoreToolsRegistered();
  return extensionExecutors();
}

export function localToolExecutor(name: string): LocalToolExecutor | undefined {
  ensureRequiredCoreToolsRegistered();
  const entry = registryEntry(name);
  return extensionExecutor(entry?.name ?? name);
}

export function localToolSpecsFromExecutors(context?: LocalToolAvailabilityContext): LocalToolSpec[] {
  return localToolExecutors()
    .filter((executor) => executor.exposure() === 'direct' && (!context || executor.isAvailable?.(context) !== false))
    .map((executor) => executor.spec());
}

export function assertLocalToolExecutorInvariants(): void {
  for (const executor of localToolExecutors()) {
    const entry = registryEntry(executor.toolName());
    if (!entry) throw new Error(`${executor.toolName()}: executor has no registry entry.`);
    if (executor.accessTier() !== entry.accessTier) throw new Error(`${executor.toolName()}: executor accessTier drifted from registry.`);
    if (executor.actionKind() !== entry.actionKind) throw new Error(`${executor.toolName()}: executor actionKind drifted from registry.`);
    if (executor.supportsParallelToolCalls() !== entry.parallelSafe) throw new Error(`${executor.toolName()}: executor parallel-safety drifted from registry.`);
  }
}
