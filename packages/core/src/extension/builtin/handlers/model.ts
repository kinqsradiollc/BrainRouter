// ADR-041 D8 — agent-initiated model control. switch_model overlays a named LLM
// profile onto the live config for the rest of the session (MC-D3). It mutates the
// live config via the host's setLLMConfig but takes no approval prompt or lease
// (it is refused outright inside reviewed execution, where model identity is
// fixed), so it migrates verbatim. Body is the former case body verbatim.

import { getCliKnobs, loadOrInitConfig, type LLMConfig } from '../../../config/config.js';
import { resolveActiveMode, setSessionMode } from '../../../session/state/sessionModeStore.js';
import { setSessionRuntime } from '../../../session/state/sessionRuntimeStore.js';
import { resolveProfileSwitch } from '../../../provider/llmProfiles.js';
import { buildModelRegistry, resolveRoutes } from '../../../provider/routing/index.js';
import { traceEvent } from '../../../telemetry/tracing/tracing.js';
import type { BuiltinToolHandler } from './registry.js';

export const modelHandlers: Record<string, BuiltinToolHandler> = {
  switch_model: async ({ args, host }) => {
    if (host.inheritedExecutionAuthorityGuard()) {
      throw new Error(
        'switch_model is unavailable inside reviewed execution because the reviewed provider and model identity are fixed for the execution.',
      );
    }
    const knobs = getCliKnobs();
    const inFastMode = resolveActiveMode(host.workspaceRoot, host.sessionKey).executionMode === 'fast';
    const profileName = String(args.profile ?? '');
    const rawProfile = knobs.llmProfiles?.[profileName.trim()];
    const routeProfileModel = knobs.router.enabled && !rawProfile?.endpoint;
    const result = resolveProfileSwitch(String(args.profile ?? ''), knobs.llmProfiles, host.llmConfig, {
      availableModels: knobs.availableModels,
      enforceAvailableModels: routeProfileModel ? false : knobs.enforceAvailableModels,
      fastMode: routeProfileModel ? false : inFastMode,
    });
    if (!result.ok) return JSON.stringify({ switched: false, error: result.error });
    const before = host.llmConfig.model;
    let nextLlm = result.llm;
    let resolvedRoute = '';
    if (routeProfileModel) {
      const config = loadOrInitConfig();
      const baseName = config.providers?.base ? 'base-config' : 'base';
      const registry = buildModelRegistry(
        { ...(config.providers ?? {}), [baseName]: host.llmConfig },
        {
          aliases: knobs.router.aliases,
          chain: [...knobs.router.chain, ...knobs.fallbackModels, `${baseName}/${host.llmConfig.model}`],
          order: knobs.router.order,
          strategy: knobs.router.strategy,
          passThrough: knobs.router.passThrough,
          availableModels: knobs.availableModels,
          enforceAvailableModels: knobs.enforceAvailableModels || inFastMode,
        },
      );
      const route = resolveRoutes(registry, result.profile.model, { withFallbacks: true })[0];
      if (!route) {
        return JSON.stringify({
          switched: false,
          error: `Router could not resolve profile "${result.name}" model "${result.profile.model}".`,
        });
      }
      nextLlm = { ...route.llm };
      resolvedRoute = route.slug;
    }
    host.setLLMConfig(nextLlm);
    try {
      setSessionRuntime(host.workspaceRoot, host.sessionKey, {
        model: routeProfileModel ? result.profile.model : nextLlm.model,
        endpoint: result.profile.endpoint ?? '',
        llmProfile: result.name,
      });
      if (result.profile.reasoningEffort) {
        setSessionMode(host.workspaceRoot, host.sessionKey, { effort: result.profile.reasoningEffort });
      }
    } catch { /* persistence is best-effort; the live switch already applied */ }
    traceEvent('model.profile_switch', {
      from: before,
      to: nextLlm.model,
      profile: result.name,
      route: resolvedRoute || null,
      reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
    });
    return JSON.stringify({
      switched: true,
      profile: result.name,
      from: before,
      to: nextLlm.model,
      route: resolvedRoute || undefined,
      note: 'Applies from the next model call onward in this session.',
    });
  },
};
