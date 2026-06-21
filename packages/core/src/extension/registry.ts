/**
 * EXTENSION-REGISTRY (0.4.15) — the in-memory aggregation of everything the
 * loaded extensions contribute: agent tools, providers, and typed lifecycle
 * hook handlers. The loader fills this via the ExtensionHost; the core
 * registries (`tool/registry.ts`, `tool/executors.ts`, `provider/catalog.ts`)
 * and the agent's hook fire-points read it.
 *
 * Imports are TYPE-ONLY (no value import from tool/provider/hooks) so this stays
 * a leaf and never forms an import cycle with the registries that consume it.
 */
import type { LocalToolExecutor } from '../tool/executors.js';
import type { LocalToolEntry } from '../tool/registry.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import type { HookEvent } from '../hooks/hooksStore.js';

/** Context passed to a typed extension hook handler. */
export interface ExtensionHookContext {
  event: HookEvent;
  /** Tool name for pre-tool / post-tool events. */
  tool?: string;
  /** Tool args for pre-tool events (the handler may inspect them in-process). */
  args?: Record<string, unknown>;
  workspaceRoot: string;
}

/** A typed, in-process lifecycle handler — the code analogue of a shell hook. */
export interface ExtensionHookHandler {
  event: HookEvent;
  /** Optional substring match on the tool name (pre-tool / post-tool), like Hook.match. */
  match?: string;
  /** Return 'deny' to block (pre-tool / user-prompt-submit), else undefined. */
  handle(ctx: ExtensionHookContext): Promise<'deny' | void> | 'deny' | void;
}

interface ToolContribution { entry: LocalToolEntry; executor: LocalToolExecutor; from: string }
interface ProviderContribution { def: ProviderDefinition; from: string }
interface HookContribution { handler: ExtensionHookHandler; from: string }

const toolContribs: ToolContribution[] = [];
const providerContribs: ProviderContribution[] = [];
const hookContribs: HookContribution[] = [];

/** Register a contributed tool. Last registration for a name wins (the loader's
 *  tier order makes workspace shadow user shadow built-in). */
export function registerExtensionTool(entry: LocalToolEntry, executor: LocalToolExecutor, from: string): void {
  const idx = toolContribs.findIndex((t) => t.entry.name === entry.name);
  if (idx >= 0) toolContribs.splice(idx, 1);
  toolContribs.push({ entry, executor, from });
}

export function registerExtensionProvider(def: ProviderDefinition, from: string): void {
  const idx = providerContribs.findIndex((p) => p.def.id === def.id);
  if (idx >= 0) providerContribs.splice(idx, 1);
  providerContribs.push({ def, from });
}

export function registerExtensionHook(handler: ExtensionHookHandler, from: string): void {
  hookContribs.push({ handler, from });
}

/** Registry entries for the contributed tools (drives access-tier exposure). */
export function extensionToolEntries(): LocalToolEntry[] {
  return toolContribs.map((t) => t.entry);
}

/** The executor for a contributed tool (or undefined for a native/unknown tool). */
export function extensionExecutor(name: string): LocalToolExecutor | undefined {
  return toolContribs.find((t) => t.entry.name === name)?.executor;
}

/** All contributed tool executors (for spec exposure). */
export function extensionExecutors(): LocalToolExecutor[] {
  return toolContribs.map((t) => t.executor);
}

/** Contributed provider definitions (inserted after built-ins in the catalog). */
export function extensionProviders(): ProviderDefinition[] {
  return providerContribs.map((p) => p.def);
}

/** Contributed handlers for one lifecycle event (run alongside shell hooks). */
export function extensionHookHandlers(event: HookEvent): ExtensionHookHandler[] {
  return hookContribs.filter((h) => h.handler.event === event).map((h) => h.handler);
}

/** A compact summary for `brainrouter ext list` / diagnostics. */
export function extensionContributionSummary(): { tools: string[]; providers: string[]; hooks: number } {
  return {
    tools: toolContribs.map((t) => `${t.entry.name} (${t.from})`),
    providers: providerContribs.map((p) => `${p.def.id} (${p.from})`),
    hooks: hookContribs.length,
  };
}

/** Drop all contributions — used on reload and by tests. */
export function resetExtensionContributions(): void {
  toolContribs.length = 0;
  providerContribs.length = 0;
  hookContribs.length = 0;
}
