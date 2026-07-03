/**
 * MC-D3 — NAMED LLM PROFILES (0.4.17).
 *
 * A profile (`cli.llmProfiles.<name>`) is a reusable model preset — model id
 * plus optional endpoint / reasoning depth / Fast-mode preference — layered
 * over the base `llm` config. Three consumers compose these pure helpers:
 *
 *  - startup: `applyActiveLlmProfile` overlays `cli.activeLlmProfile` onto the
 *    base LLM before the Agent is constructed (session-runtime overrides still
 *    win afterwards, so per-chat model picks behave exactly as before);
 *  - `/profile` slash command: list / use / save / delete;
 *  - the agent's `switch_model` tool: `resolveProfileSwitch` validates the
 *    target (profile exists + `availableModels` allowlist gate) and returns
 *    the overlaid LLMConfig the runtime applies for subsequent model calls —
 *    the explicit sibling of the first-line tier self-escalation marker.
 *
 * Everything here is PURE (transforms over config shapes); callers own
 * persistence. Mirrors the style of `agentModels.ts`.
 */
import type { LLMConfig, LlmProfileConfig } from '../config/config.js';
import { assertModelAllowed } from './modelPolicy.js';

/** Sorted profile names (stable listing for menus + tool descriptions). */
export function listLlmProfileNames(profiles: Record<string, LlmProfileConfig> | undefined): string[] {
  return Object.keys(profiles ?? {}).sort();
}

/**
 * Overlay one profile onto a base LLM config. The base provider + API key
 * always carry over (a profile is a preset, not a credential store); the
 * profile's model replaces the base model, and its endpoint (when set)
 * replaces the base endpoint. Like `resolveAgentLlm`, the saved-provider
 * `models` allowlist never rides along on a resolved/active LLM.
 */
export function overlayLlmProfile(baseLlm: LLMConfig, profile: LlmProfileConfig): LLMConfig {
  const resolved: LLMConfig = {
    ...baseLlm,
    model: profile.model,
    ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
  };
  delete resolved.models;
  return resolved;
}

/**
 * Startup overlay: apply the active profile (if any) to the base LLM config.
 * No profiles / no active pointer / unknown name → the base config unchanged,
 * so the feature is inert by default.
 */
export function applyActiveLlmProfile(
  knobs: { llmProfiles: Record<string, LlmProfileConfig>; activeLlmProfile: string },
  baseLlm: LLMConfig,
): LLMConfig {
  const name = (knobs.activeLlmProfile ?? '').trim();
  const profile = name ? knobs.llmProfiles?.[name] : undefined;
  if (!profile) return { ...baseLlm };
  return overlayLlmProfile(baseLlm, profile);
}

/**
 * Whether the agent should be OFFERED the `switch_model` tool: only when the
 * install has 2+ named profiles. With 0–1 profiles there is nothing to switch
 * between, so the surface stays hidden and default behavior is unchanged.
 */
export function switchModelToolAvailable(profiles: Record<string, LlmProfileConfig> | undefined): boolean {
  return Object.keys(profiles ?? {}).length >= 2;
}

export interface ProfileSwitchOptions {
  /** CC-CONFIG-A3 allowlist — a profile whose model is unsanctioned is refused. */
  availableModels?: readonly string[];
  enforceAvailableModels?: boolean;
  /** Fast mode always enforces the allowlist (mirrors the `/model` gate). */
  fastMode?: boolean;
}

export type ProfileSwitchResult =
  | { ok: true; name: string; profile: LlmProfileConfig; llm: LLMConfig }
  | { ok: false; error: string };

/**
 * Validate + resolve an agent-initiated profile switch. Refuses when:
 *  - fewer than 2 profiles are configured (tool shouldn't have been offered);
 *  - the target name is blank or names no configured profile;
 *  - the profile's model fails the `availableModels` enforcement gate
 *    (`enforceAvailableModels`, or always in Fast mode — same rule as `/model`).
 * On success returns the overlaid LLMConfig the caller applies to the session.
 */
export function resolveProfileSwitch(
  target: string,
  profiles: Record<string, LlmProfileConfig> | undefined,
  baseLlm: LLMConfig,
  opts: ProfileSwitchOptions = {},
): ProfileSwitchResult {
  const names = listLlmProfileNames(profiles);
  if (names.length < 2) {
    return { ok: false, error: 'switch_model is unavailable: fewer than 2 named LLM profiles are configured (cli.llmProfiles).' };
  }
  const name = (target ?? '').trim();
  if (!name) {
    return { ok: false, error: `switch_model requires a profile name. Configured profiles: ${names.join(', ')}.` };
  }
  const profile = profiles?.[name];
  if (!profile) {
    return { ok: false, error: `Unknown LLM profile "${name}". Configured profiles: ${names.join(', ')}.` };
  }
  const gate = assertModelAllowed(
    profile.model,
    opts.availableModels,
    (opts.enforceAvailableModels ?? false) || (opts.fastMode ?? false),
    opts.fastMode ? 'Fast mode' : 'This install',
  );
  if (gate) return { ok: false, error: gate };
  return { ok: true, name, profile, llm: overlayLlmProfile(baseLlm, profile) };
}
