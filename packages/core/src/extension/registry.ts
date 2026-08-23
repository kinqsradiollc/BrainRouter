/** Atomic in-memory aggregation of extension contributions. */
import type { LocalToolExecutor } from '../tool/registry/executors.js';
import type { LocalToolEntry } from '../tool/registry/registry.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import { PROVIDER_REGISTRY } from '../provider/providers/index.js';
import type { HookEvent } from '../hooks/hooksStore.js';

export interface ExtensionHookContext { event: HookEvent; tool?: string; args?: Record<string, unknown>; workspaceRoot: string }
export interface ExtensionHookHandler { event: HookEvent; match?: string; handle(ctx: ExtensionHookContext): Promise<'deny' | void> | 'deny' | void }

// ADR-041 D4b — agent phase hooks. An extension observes/steps the turn loop at
// named phases. `turn-start` / `turn-end` are serial notifications (no `next`);
// the hot-path phases (`provider-call`, `tool-execution`) are waterfalls whose
// handlers receive a `next` continuation (wired in a follow-up). The logged
// invariant (ADR-041 D4): a handler injecting model-visible context appends a
// transcript entry — it never mutates an in-flight message array.
export type AgentPhaseName = 'turn-start' | 'provider-call' | 'tool-execution' | 'turn-end';
export type PhaseNext = () => Promise<void> | void;
export interface PhaseHookContext { phase: AgentPhaseName; workspaceRoot: string; sessionKey: string }
export interface PhaseHookHandler {
  before?(ctx: PhaseHookContext, next: PhaseNext): Promise<void> | void;
  after?(ctx: PhaseHookContext, next: PhaseNext): Promise<void> | void;
}
export interface PanelContribution { id: string; title: string; icon?: string; componentKey?: string; url?: string }

interface ToolContribution { entry: LocalToolEntry; executor: LocalToolExecutor; from: string; required: boolean }
interface ProviderContribution { def: ProviderDefinition; from: string }
interface HookContribution { handler: ExtensionHookHandler; from: string }
interface PhaseHookContribution { phase: AgentPhaseName; handler: PhaseHookHandler; from: string }
interface PanelContributionEntry { panel: PanelContribution; from: string }
interface ContributionState {
  tools: ToolContribution[];
  providers: ProviderContribution[];
  hooks: HookContribution[];
  phaseHooks: PhaseHookContribution[];
  panels: PanelContributionEntry[];
}

const emptyState = (): ContributionState => ({ tools: [], providers: [], hooks: [], phaseHooks: [], panels: [] });
let active = emptyState();
let staging: ContributionState | null = null;
let activeGeneration = 0;
const target = () => staging ?? active;
const markActiveMutation = (state: ContributionState): void => {
  if (state === active) activeGeneration += 1;
};
// ADR-041 D1 — mirror the ACTIVE extension providers into the live ProviderRegistry
// so routing get()/has() resolves them (not just the catalog). Called whenever the
// active set becomes authoritative (direct register, or a reload commit/abort).
const syncExtensionProviders = (): void => {
  PROVIDER_REGISTRY.setExtensionProviders(active.providers.map((p) => p.def));
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
  syncExtensionProviders();
}
export function abortExtensionReload(): void { staging = null; syncExtensionProviders(); }

// ADR-041 A41-9 — every registrar returns a disposer that removes EXACTLY its own
// contribution, by object identity. Identity (not name/id) is what makes it safe:
// a later re-registration under the same name replaces this contribution, and
// disposing this stale handle must never remove that newer one. The object
// reference survives a reload commit (active = staging swaps arrays, not objects),
// so a disposer captured before commit still finds its contribution after.
export type ExtensionDisposer = () => void;
function disposeContribution<T>(pick: (s: ContributionState) => T[], item: T, opts: { syncProviders?: boolean } = {}): void {
  for (const state of [active, staging]) {
    if (!state) continue;
    const arr = pick(state);
    const i = arr.indexOf(item);
    if (i >= 0) {
      arr.splice(i, 1);
      markActiveMutation(state);
      if (opts.syncProviders && state === active) syncExtensionProviders();
    }
  }
}

export function registerExtensionTool(entry: LocalToolEntry, executor: LocalToolExecutor, from: string, options: { required?: boolean } = {}): ExtensionDisposer {
  const state = target();
  const idx = state.tools.findIndex((tool) => tool.entry.name === entry.name);
  const existing = idx >= 0 ? state.tools[idx] : undefined;
  const required = options.required === true;
  if (existing?.required && !required) throw new Error(`Tool "${entry.name}" is owned by required core extension "${existing.from}" and cannot be shadowed by "${from}".`);
  if (idx >= 0) state.tools.splice(idx, 1);
  const contribution: ToolContribution = { entry, executor, from, required };
  state.tools.push(contribution);
  markActiveMutation(state);
  return () => disposeContribution((s) => s.tools, contribution);
}
export function registerExtensionProvider(def: ProviderDefinition, from: string): ExtensionDisposer {
  const state = target(); const idx = state.providers.findIndex((item) => item.def.id === def.id); if (idx >= 0) state.providers.splice(idx, 1);
  const contribution: ProviderContribution = { def, from };
  state.providers.push(contribution); markActiveMutation(state);
  if (state === active) syncExtensionProviders(); // reload path syncs on commit
  return () => disposeContribution((s) => s.providers, contribution, { syncProviders: true });
}
export function registerExtensionHook(handler: ExtensionHookHandler, from: string): ExtensionDisposer {
  const state = target(); const contribution: HookContribution = { handler, from }; state.hooks.push(contribution); markActiveMutation(state);
  return () => disposeContribution((s) => s.hooks, contribution);
}
export function registerExtensionPhaseHook(phase: AgentPhaseName, handler: PhaseHookHandler, from: string): ExtensionDisposer {
  const state = target(); const contribution: PhaseHookContribution = { phase, handler, from }; state.phaseHooks.push(contribution); markActiveMutation(state);
  return () => disposeContribution((s) => s.phaseHooks, contribution);
}
export function registerExtensionPanel(panel: PanelContribution, from: string): ExtensionDisposer {
  const state = target(); const idx = state.panels.findIndex((item) => item.panel.id === panel.id); if (idx >= 0) state.panels.splice(idx, 1);
  const contribution: PanelContributionEntry = { panel, from }; state.panels.push(contribution); markActiveMutation(state);
  return () => disposeContribution((s) => s.panels, contribution);
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
export function phaseHookHandlers(phase: AgentPhaseName): PhaseHookHandler[] { return active.phaseHooks.filter((hook) => hook.phase === phase).map((hook) => hook.handler); }
/** Phase hooks with their registering extension id — for waterfall dispatch that reports which handler refused. */
export function phaseHookContributions(phase: AgentPhaseName): { handler: PhaseHookHandler; from: string }[] { return active.phaseHooks.filter((hook) => hook.phase === phase).map((hook) => ({ handler: hook.handler, from: hook.from })); }
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
