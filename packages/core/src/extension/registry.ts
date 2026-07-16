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
import type { LocalToolExecutor } from '../tool/registry/executors.js';
import type { LocalToolEntry } from '../tool/registry/registry.js';
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

/**
 * A SERIALIZABLE descriptor for a UI panel an extension contributes.
 *
 * Panels render in the Electron RENDERER process, so an extension cannot ship a
 * live React component across the process boundary. Instead it declares this
 * plain-data descriptor and the desktop maps it to an actual view: either a
 * renderer-resolved `componentKey` (a well-known key the app knows how to
 * render) OR a sandboxed `url` loaded in an isolated frame. Exactly one of the
 * two view specs should be provided; when both are present the renderer prefers
 * `componentKey`.
 */
export interface PanelContribution {
  /** Stable id, unique per panel. Last registration for an id wins. */
  id: string;
  /** Human-facing title shown in the panel tab / chrome. */
  title: string;
  /** Optional icon name or emoji the renderer maps to a glyph. */
  icon?: string;
  /** A well-known component key the desktop renderer resolves to a view. */
  componentKey?: string;
  /** A sandboxed URL rendered in an isolated frame (alternative to componentKey). */
  url?: string;
}

interface ToolContribution { entry: LocalToolEntry; executor: LocalToolExecutor; from: string }
interface ProviderContribution { def: ProviderDefinition; from: string }
interface HookContribution { handler: ExtensionHookHandler; from: string }
interface PanelContributionEntry { panel: PanelContribution; from: string }

const toolContribs: ToolContribution[] = [];
const providerContribs: ProviderContribution[] = [];
const hookContribs: HookContribution[] = [];
const panelContribs: PanelContributionEntry[] = [];

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

/** Register a contributed UI panel. Last registration for an id wins (the
 *  loader's tier order makes workspace shadow user shadow built-in). */
export function registerExtensionPanel(panel: PanelContribution, from: string): void {
  const idx = panelContribs.findIndex((p) => p.panel.id === panel.id);
  if (idx >= 0) panelContribs.splice(idx, 1);
  panelContribs.push({ panel, from });
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

/** Contributed UI panel descriptors (the desktop renderer maps these to views). */
export function extensionPanels(): PanelContribution[] {
  return panelContribs.map((p) => p.panel);
}

/** The descriptor for one contributed panel by id (or undefined if unknown). */
export function extensionPanel(id: string): PanelContribution | undefined {
  return panelContribs.find((p) => p.panel.id === id)?.panel;
}

/** A compact summary for `brainrouter ext list` / diagnostics. */
export function extensionContributionSummary(): { tools: string[]; providers: string[]; hooks: number; panels: string[] } {
  return {
    tools: toolContribs.map((t) => `${t.entry.name} (${t.from})`),
    providers: providerContribs.map((p) => `${p.def.id} (${p.from})`),
    hooks: hookContribs.length,
    panels: panelContribs.map((p) => `${p.panel.id} (${p.from})`),
  };
}

/** Drop all contributions — used on reload and by tests. */
export function resetExtensionContributions(): void {
  toolContribs.length = 0;
  providerContribs.length = 0;
  hookContribs.length = 0;
  panelContribs.length = 0;
}
