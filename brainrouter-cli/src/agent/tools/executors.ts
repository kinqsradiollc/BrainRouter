import type { AccessMode, ActionKind } from '../../runtime/exec/execPolicy.js';
import { LOCAL_TOOLS } from './specs.js';
import { LOCAL_TOOL_REGISTRY, registryEntry } from './registry.js';

export type ToolExposure = 'direct' | 'hidden';

export interface LocalToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LocalToolInvocation {
  args: Record<string, any>;
  /**
   * Transitional adapter while handlers move out of Agent.executeLocalTool.
   * Each executor owns the contract now; concrete handlers can replace this
   * callback one tool at a time without changing the caller.
   */
  legacyHandle: (name: string, args: Record<string, any>) => Promise<string>;
}

/**
 * CODEX-TOOL-EXECUTOR — TypeScript analogue of Codex CLI's ToolExecutor trait.
 *
 * A model tool's spec, exposure, policy metadata, parallel safety, and runtime
 * entrypoint now live behind one object. BrainRouter still delegates many
 * concrete handlers to Agent's legacy switch, but the host/runtime boundary no
 * longer has to recombine facts from three unrelated tables.
 */
export interface LocalToolExecutor {
  toolName(): string;
  spec(): LocalToolSpec;
  exposure(): ToolExposure;
  accessTier(): AccessMode;
  actionKind(): ActionKind;
  supportsParallelToolCalls(): boolean;
  handle(invocation: LocalToolInvocation): Promise<string>;
}

class RegistryBackedLocalToolExecutor implements LocalToolExecutor {
  constructor(
    private readonly toolSpec: LocalToolSpec,
    private readonly access: AccessMode,
    private readonly action: ActionKind,
    private readonly parallelSafe: boolean,
    private readonly toolExposure: ToolExposure = 'direct',
  ) {}

  toolName(): string {
    return this.toolSpec.name;
  }

  spec(): LocalToolSpec {
    return this.toolSpec;
  }

  exposure(): ToolExposure {
    return this.toolExposure;
  }

  accessTier(): AccessMode {
    return this.access;
  }

  actionKind(): ActionKind {
    return this.action;
  }

  supportsParallelToolCalls(): boolean {
    return this.parallelSafe;
  }

  async handle(invocation: LocalToolInvocation): Promise<string> {
    return invocation.legacyHandle(this.toolSpec.name, invocation.args);
  }
}

let cachedExecutors: LocalToolExecutor[] | undefined;
let cachedExecutorByName: Map<string, LocalToolExecutor> | undefined;

export function localToolExecutors(): LocalToolExecutor[] {
  if (cachedExecutors) return cachedExecutors;
  const specByName = new Map<string, LocalToolSpec>(
    (LOCAL_TOOLS as LocalToolSpec[]).map((tool) => [tool.name, tool]),
  );
  cachedExecutors = LOCAL_TOOL_REGISTRY.map((entry) => {
    const spec = specByName.get(entry.name);
    if (!spec) {
      throw new Error(`LOCAL_TOOL_EXECUTORS: registry entry "${entry.name}" has no LOCAL_TOOLS spec.`);
    }
    return new RegistryBackedLocalToolExecutor(
      spec,
      entry.accessTier,
      entry.actionKind,
      entry.parallelSafe,
    );
  });
  cachedExecutorByName = new Map(cachedExecutors.map((executor) => [executor.toolName(), executor]));
  return cachedExecutors;
}

export function localToolExecutor(name: string): LocalToolExecutor | undefined {
  if (!cachedExecutorByName) localToolExecutors();
  return cachedExecutorByName?.get(name);
}

export function localToolSpecsFromExecutors(): LocalToolSpec[] {
  return localToolExecutors()
    .filter((executor) => executor.exposure() === 'direct')
    .map((executor) => executor.spec());
}

export function assertLocalToolExecutorInvariants(): void {
  for (const executor of localToolExecutors()) {
    const entry = registryEntry(executor.toolName());
    if (!entry) throw new Error(`${executor.toolName()}: executor has no registry entry.`);
    if (executor.accessTier() !== entry.accessTier) {
      throw new Error(`${executor.toolName()}: executor accessTier drifted from registry.`);
    }
    if (executor.actionKind() !== entry.actionKind) {
      throw new Error(`${executor.toolName()}: executor actionKind drifted from registry.`);
    }
    if (executor.supportsParallelToolCalls() !== entry.parallelSafe) {
      throw new Error(`${executor.toolName()}: executor parallel-safety drifted from registry.`);
    }
  }
}
