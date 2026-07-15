/**
 * MULTI-PROVIDER + PER-SUB-AGENT MODELS (0.4.15)
 *
 * BrainRouter speaks one wire format (OpenAI-compatible `/v1/chat/completions`),
 * so "multiple providers" = multiple NAMED endpoints (`Config.providers`), each
 * an `LLMConfig` (endpoint + key + default model). `Config.agentModels` then
 * routes each sub-agent ROLE to a provider/model, so e.g. the explorer can run a
 * cheap/fast model while the reviewer runs a strong one.
 *
 * Everything here is PURE (transforms over `Config`); the CLI `/config` command,
 * the desktop host actions, and the orchestration spawn path all compose these.
 * Mutations return a NEW config — the caller persists with `saveConfig`.
 */
import type { Config, LLMConfig, AgentModelAssignment } from '../config/config.js';
import { resolveCliKnobs } from '../config/config.js';
import { buildModelRegistry, resolveRoutes } from '../router/index.js';

/**
 * Sub-agent roles that can have their own model. The entry named `default` is
 * the optional sub-agent fallback, not the app's main default provider; it
 * applies only to sub-agents without a role-specific entry. Mirrors
 * `orchestration/roles.ts`.
 */
export const SUBAGENT_ROLES = ['default', 'explorer', 'architect', 'reviewer', 'worker', 'verifier'] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export function isSubagentRole(x: unknown): x is SubagentRole {
  return typeof x === 'string' && (SUBAGENT_ROLES as readonly string[]).includes(x);
}

/**
 * The MEMORY BRAIN's own model-consuming cognitive roles — DISTINCT from the
 * coding agent's {@link SUBAGENT_ROLES}. The brain runs its own LLM workers
 * (memory extraction vs synthesis/distillation can use different models via
 * `BRAINROUTER_EXTRACTION_MODEL` / `BRAINROUTER_SYNTHESIS_MODEL`), so its "sub-agent
 * model" routing is keyed by these roles, not the coding roles above. Each role
 * overrides the model on the shared LLM provider.
 */
export const BRAIN_AGENT_ROLES = ['extraction', 'synthesis', 'judge', 'security-review', 'code-review', 'pentest', 'meeting-summary'] as const;
export type BrainAgentRole = (typeof BRAIN_AGENT_ROLES)[number];

export function isBrainAgentRole(x: unknown): x is BrainAgentRole {
  return typeof x === 'string' && (BRAIN_AGENT_ROLES as readonly string[]).includes(x);
}

/** Named providers configured (beyond the main `llm`). */
export function listProviderNames(config: Pick<Config, 'providers'>): string[] {
  return Object.keys(config.providers ?? {}).sort();
}

export function getProvider(config: Pick<Config, 'providers'>, name: string): LLMConfig | undefined {
  return config.providers?.[name];
}

/**
 * Resolve the LLM a sub-agent of `role` should use. Pure.
 *  - No assignment for the role (or a `default`) → the parent's `baseLlm`.
 *  - Assignment with a `provider` that exists → that provider (endpoint/key),
 *    with the assignment's `model` (or the provider's default model).
 *  - Assignment with only a `model` → the parent's provider, that model.
 * `baseLlm` is the PARENT's resolved LLM (which already honors any per-session
 * override), so a role with no assignment inherits exactly what it does today.
 */
export function resolveAgentLlm(
  config: Pick<Config, 'providers' | 'agentModels' | 'cli'>,
  baseLlm: LLMConfig,
  role: string,
): LLMConfig {
  const assign = config.agentModels?.[role] ?? config.agentModels?.['default'];
  if (!assign || (!assign.provider && !assign.model)) return baseLlm;
  const knobs = resolveCliKnobs(config as Config);
  if (knobs.router.enabled) {
    const baseName = config.providers?.base ? 'base-config' : 'base';
    const providers = { ...(config.providers ?? {}), [baseName]: baseLlm };
    const request = assign.provider && assign.model
      ? `${assign.provider}/${assign.model}`
      : assign.provider
        ? `${assign.provider}/${config.providers?.[assign.provider]?.model ?? ''}`
        : assign.model ?? '';
    const registry = buildModelRegistry(providers, {
      aliases: knobs.router.aliases,
      chain: [...knobs.router.chain, ...knobs.fallbackModels, `${baseName}/${baseLlm.model}`],
      order: knobs.router.order,
      strategy: knobs.router.strategy,
      passThrough: knobs.router.passThrough,
      availableModels: knobs.availableModels,
      enforceAvailableModels: knobs.enforceAvailableModels,
    });
    // withFallbacks:false — a sub-agent role must resolve to its DECLARED model.
    // The router still routes a bare, catalog-known model by order/strategy, but
    // an explicit provider/model (or an uncached model) that the router can't
    // place must NOT be hijacked by the primary chain — it falls through to the
    // legacy pin below (parent provider + the declared model).
    const route = resolveRoutes(registry, request, { withFallbacks: false, role })[0];
    if (route) return { ...route.llm };
  }
  const provider = assign.provider ? config.providers?.[assign.provider] : undefined;
  const base = provider ?? baseLlm;
  const model = (assign.model && assign.model.trim()) || base.model;
  const resolved: LLMConfig = { ...base, model };
  // The multi-select `models` allowlist is a SAVED-provider concept; a resolved/
  // active LLM carries only provider/key/model/endpoint (mirrors the rule that
  // `config.llm` never holds the allowlist), so don't let it ride along.
  delete resolved.models;
  return resolved;
}

export function resolveCriticLlm(
  config: Pick<Config, 'providers' | 'agentModels' | 'cli'>,
  baseLlm: LLMConfig,
): LLMConfig {
  const criticRole = config.agentModels?.critic ? 'critic' : 'reviewer';
  const roleLlm = resolveAgentLlm(config, baseLlm, criticRole);
  const knobs = resolveCliKnobs(config as Config);
  const request = knobs.critic.model;
  if (!request) return roleLlm;
  if (knobs.router.enabled) {
    const baseName = config.providers?.base ? 'base-config' : 'base';
    const registry = buildModelRegistry(
      { ...(config.providers ?? {}), [baseName]: roleLlm },
      {
        aliases: knobs.router.aliases,
        chain: [...knobs.router.chain, ...knobs.fallbackModels, `${baseName}/${roleLlm.model}`],
        order: knobs.router.order,
        strategy: knobs.router.strategy,
        passThrough: knobs.router.passThrough,
        availableModels: knobs.availableModels,
        enforceAvailableModels: knobs.enforceAvailableModels,
      },
    );
    const route = resolveRoutes(registry, request, { withFallbacks: true, role: 'critic' })[0];
    if (route) return { ...route.llm };
  }
  return { ...roleLlm, model: request };
}

/**
 * Reconcile a provider's single default `model` with its multi-select `models`
 * allowlist (0.4.17 Onyx-parity). Pure; the host's set-provider action and the
 * tests share this one rule so the invariant "default ∈ models" can't drift:
 *  - empty/absent/all-blank `models` → `{ model }` only — the legacy
 *    single-default shape, so no phantom `models: []` is ever persisted.
 *  - non-empty `models` → trim, drop blanks, dedupe (order preserved); ensure
 *    the default is a member, falling back to `models[0]` when it isn't.
 */
export function normalizeProviderModels(
  model: string,
  models: readonly string[] | undefined,
): { model: string; models?: string[] } {
  const deduped = [...new Set((models ?? []).map((m) => m.trim()).filter(Boolean))];
  if (deduped.length === 0) return { model };
  const def = deduped.includes(model.trim()) ? model.trim() : deduped[0];
  return { model: def, models: deduped };
}

/** Add or replace a named provider. Returns a NEW config. */
export function setProvider(config: Config, name: string, llm: LLMConfig): Config {
  const providers = { ...(config.providers ?? {}), [name]: llm };
  return { ...config, providers };
}

/**
 * Remove a named provider, and clear any `agentModels` assignment that pointed
 * at it (so no role is left referencing a provider that no longer exists).
 * Returns a NEW config.
 */
export function removeProvider(config: Config, name: string): Config {
  if (!config.providers?.[name]) return config;
  const providers = { ...config.providers };
  delete providers[name];
  let agentModels = config.agentModels;
  if (agentModels) {
    const next: Record<string, AgentModelAssignment> = {};
    for (const [role, a] of Object.entries(agentModels)) {
      if (a.provider === name) {
        // Drop the dangling provider but keep a model-only override if present.
        if (a.model) next[role] = { model: a.model };
      } else {
        next[role] = a;
      }
    }
    agentModels = Object.keys(next).length ? next : undefined;
  }
  const out: Config = { ...config, providers: Object.keys(providers).length ? providers : undefined };
  if (agentModels) out.agentModels = agentModels; else delete out.agentModels;
  return out;
}

/**
 * Assign a model/provider to a sub-agent role. An empty assignment (both fields
 * blank) CLEARS the role. Returns a NEW config.
 */
export function setAgentModel(config: Config, role: string, assign: AgentModelAssignment): Config {
  const clean: AgentModelAssignment = {};
  if (assign.provider && assign.provider.trim()) clean.provider = assign.provider.trim();
  if (assign.model && assign.model.trim()) clean.model = assign.model.trim();
  const agentModels = { ...(config.agentModels ?? {}) };
  if (!clean.provider && !clean.model) delete agentModels[role];
  else agentModels[role] = clean;
  const out: Config = { ...config };
  if (Object.keys(agentModels).length) out.agentModels = agentModels;
  else delete out.agentModels;
  return out;
}

/** A compact, human-readable summary of a role's effective model (for menus). */
export function describeAgentModel(
  config: Pick<Config, 'providers' | 'agentModels' | 'llm'>,
  role: string,
): string {
  const assign = config.agentModels?.[role] ?? config.agentModels?.['default'];
  if (!assign || (!assign.provider && !assign.model)) return 'inherits main model';
  const providerLabel = assign.provider ? assign.provider : '(main)';
  const model = assign.model || config.providers?.[assign.provider ?? '']?.model || config.llm?.model || '?';
  return `${providerLabel} · ${model}`;
}
