/** Atomic in-memory aggregation of extension contributions. */
import type { LocalToolExecutor } from '../tool/registry/executors.js';
import type { LocalToolEntry } from '../tool/registry/registry.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import type { HookEvent } from '../hooks/hooksStore.js';

export interface ExtensionHookContext { event: HookEvent; tool?: string; args?: Record<string, unknown>; workspaceRoot: string }
export interface ExtensionHookHandler { event: HookEvent; match?: string; handle(ctx: ExtensionHookContext): Promise<'deny' | void> | 'deny' | void }
export interface PanelContribution { id: string; title: string; icon?: string; componentKey?: string; url?: string }

interface ToolContribution { entry: LocalToolEntry; executor: LocalToolExecutor; from: string; required: boolean }
interface ProviderContribution { def: ProviderDefinition; from: string }
interface HookContribution { handler: ExtensionHookHandler; from: string }
interface PanelContributionEntry { panel: PanelContribution; from: string }
interface ContributionState {
  tools: ToolContribution[];
  providers: ProviderContribution[];
  hooks: HookContribution[];
  panels: PanelContributionEntry[];
}

const emptyState = (): ContributionState => ({ tools: [], providers: [], hooks: [], panels: [] });
let active = emptyState();
let staging: ContributionState | null = null;
let activeGeneration = 0;
const target = () => staging ?? active;
const markActiveMutation = (state: ContributionState): void => {
  if (state === active) activeGeneration += 1;
};

export function beginExtensionReload(): void {
  if (staging) throw new Error('An extension reload is already in progress.');
  staging = emptyState();
}
export function commitExtensionReload(): void {
  if (!staging) throw new Error('No extension reload is in progress.');
  active = staging;
  staging = null;
  activeGeneration += 1;
}
export function abortExtensionReload(): void { staging = null; }

export function registerExtensionTool(entry: LocalToolEntry, executor: LocalToolExecutor, from: string, options: { required?: boolean } = {}): void {
  const state = target();
  const idx = state.tools.findIndex((tool) => tool.entry.name === entry.name);
  const existing = idx >= 0 ? state.tools[idx] : undefined;
  const required = options.required === true;
  if (existing?.required && !required) throw new Error(`Tool "${entry.name}" is owned by required core extension "${existing.from}" and cannot be shadowed by "${from}".`);
  if (idx >= 0) state.tools.splice(idx, 1);
  state.tools.push({ entry, executor, from, required });
  markActiveMutation(state);
}
export function registerExtensionProvider(def: ProviderDefinition, from: string): void {
  const state = target(); const idx = state.providers.findIndex((item) => item.def.id === def.id); if (idx >= 0) state.providers.splice(idx, 1); state.providers.push({ def, from }); markActiveMutation(state);
}
export function registerExtensionHook(handler: ExtensionHookHandler, from: string): void {
  const state = target(); state.hooks.push({ handler, from }); markActiveMutation(state);
}
export function registerExtensionPanel(panel: PanelContribution, from: string): void {
  const state = target(); const idx = state.panels.findIndex((item) => item.panel.id === panel.id); if (idx >= 0) state.panels.splice(idx, 1); state.panels.push({ panel, from }); markActiveMutation(state);
}

export function extensionToolEntries(): LocalToolEntry[] { return active.tools.map((tool) => tool.entry); }
export function extensionExecutor(name: string): LocalToolExecutor | undefined { return active.tools.find((tool) => tool.entry.name === name)?.executor; }
export function extensionExecutors(): LocalToolExecutor[] { return active.tools.map((tool) => tool.executor); }
export function requiredExtensionToolNames(): ReadonlySet<string> { return new Set(active.tools.filter((tool) => tool.required).map((tool) => tool.entry.name)); }
export function extensionToolOwner(name: string): { extension: string; required: boolean } | undefined {
  const tool = active.tools.find((item) => item.entry.name === name); return tool ? { extension: tool.from, required: tool.required } : undefined;
}
export function extensionProviders(): ProviderDefinition[] { return active.providers.map((provider) => provider.def); }
export function extensionHookHandlers(event: HookEvent): ExtensionHookHandler[] { return active.hooks.filter((hook) => hook.handler.event === event).map((hook) => hook.handler); }
export function extensionPanels(): PanelContribution[] { return active.panels.map((panel) => panel.panel); }
export function extensionPanel(id: string): PanelContribution | undefined { return active.panels.find((panel) => panel.panel.id === id)?.panel; }
export function extensionContributionSummary(): { tools: string[]; providers: string[]; hooks: number; panels: string[] } {
  return { tools: active.tools.map((tool) => `${tool.entry.name} (${tool.from}${tool.required ? ', required' : ''})`), providers: active.providers.map((provider) => `${provider.def.id} (${provider.from})`), hooks: active.hooks.length, panels: active.panels.map((panel) => `${panel.panel.id} (${panel.from})`) };
}
/** Monotonic process-local fence; returning to an old contribution shape does not revive authority. */
export function extensionContributionGeneration(): number { return activeGeneration; }
export function resetExtensionContributions(): void {
  active = emptyState();
  staging = null;
  activeGeneration += 1;
}
