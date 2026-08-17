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
import type { AccessMode, ActionKind } from '../exec/policy/execPolicy.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import {
  registerExtensionTool,
  registerExtensionProvider,
  registerExtensionHook,
  registerExtensionPhaseHook,
  registerExtensionPanel,
  type ExtensionHookHandler,
  type AgentPhaseName,
  type PhaseHookHandler,
  type PanelContribution,
} from './registry.js';
import { registerBuiltinCapability } from './builtin/capabilities.js';
import type { ExtensionSource } from './manifest.js';
import type { BrowserControlPort } from '../browser/control.js';
import type { SessionInputPort } from '../session/input/inputDelivery.js';

/** Narrow runtime context available only to a packaged built-in browser extension. */
export interface ExtensionToolRuntimeContext {
  browserControlPort?: BrowserControlPort;
  sessionInputPort?: SessionInputPort;
  signal?: AbortSignal;
}

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
  /** Include this call in policy audit events even when its action kind is network. */
  audited?: boolean;
  /** Privileged per-Agent runtime port. Only packaged built-in extensions may request it. */
  runtimePort?: 'browser-control' | 'session-input';
  /** The runtime — receives the parsed args, returns the tool-result string. */
  handle(args: Record<string, unknown>, runtime?: ExtensionToolRuntimeContext): Promise<string> | string;
}

export interface ExtensionHost {
  /** Register an agent tool at an access tier (same contract as native tools). */
  registerTool(def: ExtensionToolDef): void;
  /** Register an OpenAI-compatible provider definition in code. */
  registerProvider(def: ProviderDefinition): void;
  /** Attach a typed lifecycle handler (in-process analogue of a shell hook). */
  registerHook(handler: ExtensionHookHandler): void;
  /** ADR-041 D4b — attach an agent phase hook (turn-start/provider-call/tool-execution/turn-end). */
  registerPhaseHook(phase: AgentPhaseName, handler: PhaseHookHandler): void;
  /** Contribute a serializable UI panel descriptor the desktop renderer maps to a view. */
  registerPanel(descriptor: PanelContribution): void;
  /** Structured logger scoped to the extension name. */
  readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  readonly workspaceRoot: string;
  readonly version: string;
}

/** Privileged host shape used only for required extensions shipped inside core. */
export interface BuiltinExtensionHost extends ExtensionHost {
  registerCoreCapability(name: string): void;
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
  isAvailable(context: import('../tool/registry/executors.js').LocalToolAvailabilityContext): boolean {
    if (this.def.runtimePort === 'browser-control') return context.browserUseAvailable === true;
    if (this.def.runtimePort === 'session-input') return context.sessionInputAvailable === true;
    return true;
  }
  async handle(invocation: LocalToolInvocation): Promise<string> {
    const runtime = this.def.runtimePort === 'browser-control'
      ? { browserControlPort: invocation.browserControlPort, signal: invocation.signal }
      : this.def.runtimePort === 'session-input'
        ? { sessionInputPort: invocation.sessionInputPort, signal: invocation.signal }
        : undefined;
    return String(await this.def.handle(invocation.args, runtime));
  }
}

/** Build a host bound to one extension; its registrations are attributed to `name`. */
export function createExtensionHost(
  name: string,
  workspaceRoot: string,
  version: string,
  options: { source?: ExtensionSource; required?: boolean } = {},
): ExtensionHost {
  const host: ExtensionHost & Partial<BuiltinExtensionHost> = {
    workspaceRoot,
    version,
    log: (msg, fields) => console.error(`[ext:${name}] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`),
    registerTool: (def) => {
      if (def.runtimePort && options.source !== 'builtin') {
        throw new Error(`Extension "${name}" cannot request the privileged ${def.runtimePort} runtime port.`);
      }
      const entry: LocalToolEntry = {
        name: def.name,
        accessTier: def.accessTier,
        actionKind: def.actionKind,
        parallelSafe: def.parallelSafe ?? false,
        ...(def.audited ? { audited: true } : {}),
        ...(def.runtimePort === 'browser-control' ? { runtimePort: 'browser-control', availability: 'browser-use' } : {}),
        ...(def.runtimePort === 'session-input' ? { runtimePort: 'session-input', availability: 'root-agent' } : {}),
      };
      registerExtensionTool(entry, new ExtensionToolExecutor(def), name, { required: false });
    },
    registerProvider: (def) => registerExtensionProvider(def, name),
    registerHook: (handler) => registerExtensionHook(handler, name),
    registerPhaseHook: (phase, handler) => registerExtensionPhaseHook(phase, handler, name),
    registerPanel: (descriptor) => registerExtensionPanel(descriptor, name),
  };
  // The public host never contains this port. Arbitrary user/workspace code can
  // register argument-only tools, but cannot obtain the Agent runtime bridge.
  if (options.source === 'builtin' && options.required) {
    host.registerCoreCapability = (capability) => registerBuiltinCapability(capability);
  }
  return host;
}
