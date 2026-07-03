/**
 * EXTENSION-HOST (0.4.15) — the typed surface an extension's `activate(host)`
 * uses to contribute capabilities. Each registration goes through the SAME
 * contracts native code uses: a tool registers at an access tier + action kind
 * (so the sandbox/exec-policy still gates it — an extension registers a tool
 * AT a tier, it cannot bypass the tier), a provider is a normal
 * `ProviderDefinition`, a hook is the in-process analogue of a shell hook.
 */
import type { LocalToolExecutor, LocalToolSpec, LocalToolInvocation, ToolExposure } from '../tool/registry/executors.js';
import type { LocalToolEntry } from '../tool/registry/registry.js';
import type { AccessMode, ActionKind } from '../exec/execPolicy.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import {
  registerExtensionTool,
  registerExtensionProvider,
  registerExtensionHook,
  type ExtensionHookHandler,
} from './registry.js';

/** The ergonomic shape an extension passes to `host.registerTool`. */
export interface ExtensionToolDef {
  name: string;
  description: string;
  /** JSON schema for the tool's args (the model sees this). */
  inputSchema: Record<string, unknown>;
  /** Lowest access mode that exposes the tool (read ⊂ write ⊂ shell). */
  accessTier: AccessMode;
  /** Execution action kind (governs approval + sandbox routing). */
  actionKind: ActionKind;
  /** Safe to dispatch concurrently within one assistant message. Default false. */
  parallelSafe?: boolean;
  /** The runtime — receives the parsed args, returns the tool-result string. */
  handle(args: Record<string, unknown>): Promise<string> | string;
}

export interface ExtensionHost {
  /** Register an agent tool at an access tier (same contract as native tools). */
  registerTool(def: ExtensionToolDef): void;
  /** Register an OpenAI-compatible provider definition in code. */
  registerProvider(def: ProviderDefinition): void;
  /** Attach a typed lifecycle handler (in-process analogue of a shell hook). */
  registerHook(handler: ExtensionHookHandler): void;
  /** Structured logger scoped to the extension name. */
  readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  readonly workspaceRoot: string;
  readonly version: string;
}

/** The single entrypoint an extension module must export. */
export type ExtensionActivate = (host: ExtensionHost) => void | Promise<void>;

/** Wrap an ExtensionToolDef as a first-class LocalToolExecutor. */
class ExtensionToolExecutor implements LocalToolExecutor {
  constructor(private readonly def: ExtensionToolDef) {}
  toolName(): string { return this.def.name; }
  spec(): LocalToolSpec { return { name: this.def.name, description: this.def.description, inputSchema: this.def.inputSchema }; }
  exposure(): ToolExposure { return 'direct'; }
  accessTier(): AccessMode { return this.def.accessTier; }
  actionKind(): ActionKind { return this.def.actionKind; }
  supportsParallelToolCalls(): boolean { return this.def.parallelSafe ?? false; }
  async handle(invocation: LocalToolInvocation): Promise<string> {
    return String(await this.def.handle(invocation.args));
  }
}

/** Build a host bound to one extension; its registrations are attributed to `name`. */
export function createExtensionHost(name: string, workspaceRoot: string, version: string): ExtensionHost {
  return {
    workspaceRoot,
    version,
    log: (msg, fields) => console.error(`[ext:${name}] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`),
    registerTool: (def) => {
      const entry: LocalToolEntry = {
        name: def.name,
        accessTier: def.accessTier,
        actionKind: def.actionKind,
        parallelSafe: def.parallelSafe ?? false,
      };
      registerExtensionTool(entry, new ExtensionToolExecutor(def), name);
    },
    registerProvider: (def) => registerExtensionProvider(def, name),
    registerHook: (handler) => registerExtensionHook(handler, name),
  };
}
