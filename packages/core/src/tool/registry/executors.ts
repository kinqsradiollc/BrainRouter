import type { AccessMode, ActionKind } from '../../exec/policy/execPolicy.js';
import { ensureRequiredCoreToolsRegistered, type BuiltinToolRuntimePort } from '../../extension/builtin/capabilities.js';
import { extensionExecutor, extensionExecutors } from '../../extension/registry.js';
import { registryEntry } from './registry.js';
import type { BrowserControlPort } from '../../browser/control.js';
import type { SessionInputPort } from '../../session/input/inputDelivery.js';

export type ToolExposure = 'direct' | 'hidden';
export interface LocalToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface OrchestrationRuntimePort { invoke(toolName: string, args: Record<string, any>, metadata: { workflowLaunch: boolean }): Promise<string> }
export type ToolLifecycleKind =
  | 'track-automation'
  | 'goal-reconcile'
  | 'plan-update'
  | 'steer-reconcile';
export interface ToolLifecycleRuntimePort {
  afterInvoke(kind: ToolLifecycleKind, args: Record<string, any>): void | Promise<void>;
}
export interface LocalToolInvocation {
  args: Record<string, any>;
  invokedName?: string;
  builtinRuntime?: BuiltinToolRuntimePort;
  orchestrationRuntime?: OrchestrationRuntimePort;
  lifecycleRuntime?: ToolLifecycleRuntimePort;
  /** Desktop-only, per-Agent port. Never copied into child/reviewer agents. */
  browserControlPort?: BrowserControlPort;
  /** Root-session channel for built-in background extensions. */
  sessionInputPort?: SessionInputPort;
  signal?: AbortSignal;
}
export interface LocalToolAvailabilityContext {
  resultExpansionAvailable?: boolean;
  workflowActive?: boolean;
  activeOrchestrationPlan?: boolean;
  rootAgent?: boolean;
  computerUseAvailable?: boolean;
  browserUseAvailable?: boolean;
  sessionInputAvailable?: boolean;
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

/**
 * Pure form of the executor↔registry drift invariant: returns a violation message
 * per broken executor (empty = all hold). Side-effect free, so the ADR-041 A41-14
 * runtime-invariants registry can run it and collect breaks without throwing.
 */
export function checkLocalToolExecutorInvariants(): string[] {
  const violations: string[] = [];
  for (const executor of localToolExecutors()) {
    const entry = registryEntry(executor.toolName());
    if (!entry) { violations.push(`${executor.toolName()}: executor has no registry entry.`); continue; }
    if (executor.accessTier() !== entry.accessTier) violations.push(`${executor.toolName()}: executor accessTier drifted from registry.`);
    if (executor.actionKind() !== entry.actionKind) violations.push(`${executor.toolName()}: executor actionKind drifted from registry.`);
    if (executor.supportsParallelToolCalls() !== entry.parallelSafe) violations.push(`${executor.toolName()}: executor parallel-safety drifted from registry.`);
  }
  return violations;
}

export function assertLocalToolExecutorInvariants(): void {
  const violations = checkLocalToolExecutorInvariants();
  if (violations.length > 0) throw new Error(violations[0]);
}
