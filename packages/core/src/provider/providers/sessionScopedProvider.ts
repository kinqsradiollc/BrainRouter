// ADR-041 A41-9 — session-scoped BYOK providers.
//
// A session can point at a CUSTOM model endpoint that is not in the global
// provider catalog (a "bring your own key" endpoint) via its per-session runtime
// override (provider + endpoint, sessionRuntime.json). This registers that as a
// provider ONLY that session may route to — the session-scoped reversible
// registration ADR-041 D9 calls for. It reuses the ADR-047 declarative builder
// (`declarativeToDefinition`) so a BYOK endpoint gets a real, validated
// ProviderDefinition (with its chosen wire format), and the ProviderRegistry
// session overlay (`registerForSession` / `disposeSession`) keeps it invisible to
// every other session — session B never routes to session A's endpoint.
//
// The genuine consumer is `resolveSessionLlmConfig`, which registers/refreshes the
// scoped provider whenever a session resolves a custom provider+endpoint, and
// stamps `sessionKey` on the LLMConfig so provider resolution
// (`PROVIDER_REGISTRY.get(id, sessionKey)`) finds it. A session without a custom
// endpoint registers nothing and its resolution is byte-for-byte the global path.

import { PROVIDER_REGISTRY } from './index.js';
import { declarativeToDefinition } from './declarative.js';
import type { DeclarativeProviderEntry } from '../../config/configTypes.js';

/** The per-session fields a BYOK provider is derived from. */
export interface SessionProviderInput {
  provider?: string;
  endpoint?: string;
  requestFormat?: DeclarativeProviderEntry['requestFormat'];
}

/**
 * The declarative entry for a session's BYOK endpoint, or null when the session
 * has no custom provider (no provider/endpoint, or an id already in the global
 * catalog — a builtin/known provider is never shadowed by a session).
 */
export function sessionByokEntry(input: SessionProviderInput | undefined): DeclarativeProviderEntry | null {
  const id = (input?.provider ?? '').trim().toLowerCase();
  const endpoint = (input?.endpoint ?? '').trim();
  if (!id || !endpoint) return null;
  if (PROVIDER_REGISTRY.hasBuiltin(id) || PROVIDER_REGISTRY.has(id)) return null;
  return {
    id,
    endpoint,
    pickerVisible: false,
    label: `Session provider (${id})`,
    ...(input?.requestFormat ? { requestFormat: input.requestFormat } : {}),
  };
}

/**
 * Register (or refresh) the session-scoped BYOK provider for `sessionKey` from its
 * resolved runtime, disposing any prior one first. Returns true when a scoped
 * provider is now active (so the caller stamps `sessionKey` on the LLMConfig). A
 * malformed entry is skipped (routing falls back to the OpenAI-compatible default),
 * never thrown — a bad per-session endpoint must not break the session.
 */
export function syncSessionScopedProvider(sessionKey: string, input: SessionProviderInput | undefined): boolean {
  PROVIDER_REGISTRY.disposeSession(sessionKey);
  const entry = sessionByokEntry(input);
  if (!entry) return false;
  try {
    PROVIDER_REGISTRY.registerForSession(sessionKey, declarativeToDefinition(entry));
    return true;
  } catch {
    return false;
  }
}

/** Remove a session's scoped provider (session end / override cleared). */
export function clearSessionScopedProvider(sessionKey: string): void {
  PROVIDER_REGISTRY.disposeSession(sessionKey);
}
