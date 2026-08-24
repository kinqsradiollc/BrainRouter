import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import type { LLMConfig } from '../../config/config.js';
import { syncSessionScopedProvider, clearSessionScopedProvider } from '../../provider/providers/sessionScopedProvider.js';

/**
 * T5 — per-session runtime overrides: which provider/model/endpoint and which
 * MCP profiles a SPECIFIC chat uses. Different sessions can therefore run
 * different provider/model/MCP combinations concurrently. Resolution is
 * layered — session overrides win over workspace defaults, which win over the
 * global config — so the three scopes stay cleanly separated. Persisted per
 * workspace in `sessionRuntime.json`, keyed by sessionKey.
 */
export interface SessionRuntime {
  /** Hosted terminal adapter selected for this session. */
  agentAdapter?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  /** The single active BrainRouter MCP profile — one brain per session. */
  brainProfile?: string;
  /** Additive third-party MCP profile ids enabled for this session. */
  mcpProfiles?: string[];
  /** MC-D3 — the named LLM profile (cli.llmProfiles) this session switched to,
   *  recorded by `switch_model` / `/profile use` alongside the concrete
   *  model/endpoint overrides so `/profile` can label the active preset. */
  llmProfile?: string;
  /** ADR-041 A41-9 — wire format for a session's BYOK endpoint (provider+endpoint
   *  not in the global catalog). Lets one session pin a custom endpoint's request
   *  shape (e.g. native anthropic-messages) without touching the global catalog;
   *  the provider is registered scoped to this session only. Default
   *  chat-completions when omitted. */
  byokRequestFormat?: 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-generate';
}

/** Fully-resolved runtime for a session (no optional provider/model). */
export interface ResolvedRuntime {
  provider: string;
  model: string;
  endpoint?: string;
  brainProfile?: string;
  mcpProfiles: string[];
}

type Store = Record<string, SessionRuntime>;

function runtimeFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'sessionRuntime.json');
}

export function readSessionRuntimeAll(workspaceRoot: string): Store {
  return readJsonFile<Store>(runtimeFile(workspaceRoot), {});
}

export function getSessionRuntime(workspaceRoot: string, sessionKey: string): SessionRuntime {
  return readSessionRuntimeAll(workspaceRoot)[sessionKey] ?? {};
}

/** Merge a patch; prune empty fields so a session that reverts to defaults
 *  leaves no entry (and thus inherits workspace/global cleanly). */
export function setSessionRuntime(workspaceRoot: string, sessionKey: string, patch: Partial<SessionRuntime>): SessionRuntime {
  const all = readSessionRuntimeAll(workspaceRoot);
  const next: SessionRuntime = { ...(all[sessionKey] ?? {}), ...patch };
  if (next.mcpProfiles && next.mcpProfiles.length === 0) delete next.mcpProfiles;
  for (const k of ['provider', 'model', 'endpoint', 'brainProfile', 'llmProfile', 'agentAdapter', 'byokRequestFormat'] as const) {
    if (next[k] == null || next[k] === '') delete next[k];
  }
  if (Object.keys(next).length === 0) delete all[sessionKey];
  else all[sessionKey] = next;
  writeJsonFile(runtimeFile(workspaceRoot), all);
  return all[sessionKey] ?? {};
}

export function clearSessionRuntime(workspaceRoot: string, sessionKey: string): void {
  const all = readSessionRuntimeAll(workspaceRoot);
  if (all[sessionKey]) { delete all[sessionKey]; writeJsonFile(runtimeFile(workspaceRoot), all); }
  // ADR-041 A41-9 — a cleared session runtime drops any BYOK provider scoped to it.
  clearSessionScopedProvider(sessionKey);
}

/**
 * Layered resolution: session overrides > workspace defaults > global config.
 * Pure — given the three layers, returns the concrete runtime to build the LLM
 * client + MCP pool for a session.
 */
export function resolveSessionRuntime(
  global: ResolvedRuntime,
  workspace: Partial<ResolvedRuntime> | undefined,
  session: SessionRuntime | undefined,
): ResolvedRuntime {
  const w = workspace ?? {};
  const s = session ?? {};
  return {
    provider: s.provider ?? w.provider ?? global.provider,
    model: s.model ?? w.model ?? global.model,
    endpoint: s.endpoint ?? w.endpoint ?? global.endpoint,
    brainProfile: s.brainProfile ?? w.brainProfile ?? global.brainProfile,
    mcpProfiles: s.mcpProfiles ?? w.mcpProfiles ?? global.mcpProfiles ?? [],
  };
}

/**
 * Resolve the LLM config a concrete session should use. This keeps CLI and
 * Desktop aligned: config.json is the global default, while sessionRuntime.json
 * can override provider/model/endpoint for one chat.
 */
export function resolveSessionLlmConfig(globalLlm: LLMConfig, workspaceRoot: string, sessionKey?: string): LLMConfig {
  if (!sessionKey) return { ...globalLlm };
  const session = getSessionRuntime(workspaceRoot, sessionKey);
  const resolved = resolveSessionRuntime(
    {
      provider: globalLlm.provider,
      model: globalLlm.model,
      endpoint: globalLlm.endpoint,
      mcpProfiles: [],
    },
    undefined,
    session,
  );
  // ADR-041 A41-9 — when this session resolves a custom provider+endpoint not in
  // the global catalog, register it as a provider only this session may route to
  // and stamp `sessionKey` so `PROVIDER_REGISTRY.get(id, sessionKey)` finds it.
  // Byte-neutral for an ordinary session: nothing is registered and no sessionKey
  // is stamped, so resolution is exactly the global path.
  const byok = syncSessionScopedProvider(sessionKey, {
    provider: resolved.provider,
    endpoint: resolved.endpoint,
    requestFormat: session.byokRequestFormat,
  });
  return {
    ...globalLlm,
    provider: resolved.provider,
    model: resolved.model,
    endpoint: resolved.endpoint,
    ...(byok ? { sessionKey } : {}),
  };
}
