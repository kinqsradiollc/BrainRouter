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
  config: Pick<Config, 'providers' | 'agentModels'>,
  baseLlm: LLMConfig,
  role: string,
): LLMConfig {
  const assign = config.agentModels?.[role] ?? config.agentModels?.['default'];
  if (!assign || (!assign.provider && !assign.model)) return baseLlm;
  const provider = assign.provider ? config.providers?.[assign.provider] : undefined;
  const base = provider ?? baseLlm;
  const model = (assign.model && assign.model.trim()) || base.model;
  return { ...base, model };
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
