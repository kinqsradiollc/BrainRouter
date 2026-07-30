import type { ServerConfig } from '../../config/config.js';
import type { BrainHealth } from '../types.js';
import { resolveIdentityFromConfig } from '../client/identity.js';

/**
 * Brain-profile selection + remote-brain (ADR-005) helpers.
 *
 * Pure, network-free (except the bounded `probeBrainHealth` probe) logic for
 * deciding which configured MCP profiles connect, pointing the active brain at
 * a remote Streamable-HTTP endpoint, and probing that remote's health. Extracted
 * from the pool so the pool class only owns live connection state.
 */

/**
 * Choose which configured MCP profiles should connect for a normal CLI run.
 *
 * BrainRouter profiles are special: users may store several BrainRouter MCPs
 * (local, staging, remote, self-hosted), but only one should be active at a
 * time because the BrainRouter MCP is the memory/brain plane. Third-party MCPs
 * are additive tools, so they all connect concurrently.
 *
 * `requestedProfile` is the explicit escape hatch (`--profile <name>`): it
 * scopes the run to exactly that profile, matching the existing single-server
 * mode.
 */
export function selectMcpServerIds(
  servers: Record<string, ServerConfig>,
  activeServer?: string,
  requestedProfile?: string,
): string[] {
  const ids = Object.keys(servers);
  if (requestedProfile) return servers[requestedProfile] ? [requestedProfile] : [];

  const brainrouterIds = ids.filter((id) =>
    resolveIdentityFromConfig(servers[id], id) === 'brainrouter',
  );
  const activeBrainrouter = activeServer && brainrouterIds.includes(activeServer)
    ? activeServer
    : brainrouterIds[0];

  return ids.filter((id) => {
    const identity = resolveIdentityFromConfig(servers[id], id);
    return identity !== 'brainrouter' || id === activeBrainrouter;
  });
}

/**
 * REMOTE-BRAIN (Workstream A, ADR-005) — rewrite the active BrainRouter profile
 * to talk to a remote Streamable-HTTP brain at `brainUrl`.
 *
 * The brain already speaks HTTP (`--http`, Bearer auth); this is the ergonomic
 * client side of `cli.brainUrl`: a single knob flips the active brain from
 * embedded/stdio to remote without hand-editing `servers.*`. Returns a NEW
 * servers map (input untouched) plus the id of the brain that was pointed
 * remote, so the caller can keep `activeServer` in sync.
 *
 * Rules:
 *  - `brainUrl` falsy → no-op (embedded stays the default).
 *  - An existing brain profile keeps its `apiKey`/`headers` (the bearer key the
 *    HTTP transport requires) and just swaps transport to `http` + `url`; the
 *    stdio-only fields (`command`/`args`/`env`) are dropped.
 *  - No brain profile yet → one is synthesized under `brainrouter` so a fresh
 *    install can reach a remote brain from the knob alone (the user still adds
 *    an `apiKey`).
 */
export function applyBrainUrlOverride(
  servers: Record<string, ServerConfig>,
  activeServer: string | undefined,
  brainUrl: string | null | undefined,
  apiKey?: string,
): { servers: Record<string, ServerConfig>; activeServer: string } {
  const fallbackActive = activeServer ?? '';
  if (!brainUrl) return { servers, activeServer: fallbackActive };

  const ids = Object.keys(servers);
  const brainrouterIds = ids.filter((id) => resolveIdentityFromConfig(servers[id], id) === 'brainrouter');
  const targetId = (activeServer && brainrouterIds.includes(activeServer))
    ? activeServer
    : brainrouterIds[0] ?? 'brainrouter';

  const prev = servers[targetId];
  const next: ServerConfig = {
    ...(prev ?? {}),
    type: 'http',
    url: brainUrl,
    identity: 'brainrouter',
    // stdio-only fields are meaningless over HTTP — drop them.
    command: undefined,
    args: undefined,
    env: undefined,
    apiKey: prev?.apiKey ?? apiKey,
  };

  return { servers: { ...servers, [targetId]: next }, activeServer: targetId };
}

/**
 * REMOTE-BRAIN (Workstream A, Phase 2) — the brain serves an unauthenticated
 * `GET /health` beside `/mcp` on the same origin. Derive that health URL from a
 * brain MCP URL: prefer swapping a trailing `/mcp` so a path-mounted brain
 * (`https://host/brainrouter/mcp`) probes `…/brainrouter/health` rather than the
 * host root; otherwise resolve `/health` against the origin.
 */
export function brainHealthUrl(mcpUrl: string): string {
  if (/\/mcp\/?$/.test(mcpUrl)) return mcpUrl.replace(/\/mcp\/?$/, "/health");
  return new URL("/health", mcpUrl).toString();
}

/**
 * REMOTE-BRAIN (Workstream A, Phase 2) — probe a remote brain's `GET /health`
 * with a short timeout so the client can decide remote-vs-embedded before
 * committing to a transport. Never throws: a network error / timeout / missing
 * `fetch` returns `{ ok: false, error }`. `fetchImpl` is injectable for tests.
 */
export async function probeBrainHealth(
  mcpUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; apiKey?: string },
): Promise<BrainHealth> {
  const f = opts?.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== "function") return { ok: false, error: "fetch unavailable" };

  let url: string;
  try {
    url = brainHealthUrl(mcpUrl);
  } catch {
    return { ok: false, error: `invalid brainUrl: ${mcpUrl}` };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(250, opts?.timeoutMs ?? 3_000));
  try {
    const headers: Record<string, string> = {};
    if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await f(url, { method: "GET", signal: ctrl.signal, headers });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * REMOTE-BRAIN (Workstream A, Phase 2) — the embedded fallback target: the first
 * configured stdio BrainRouter profile, or null when none exists. Used to decide
 * whether to fall back to the embedded brain when a remote is unreachable.
 */
export function embeddedBrainId(servers: Record<string, ServerConfig>): string | null {
  for (const id of Object.keys(servers)) {
    const s = servers[id];
    if (s?.type === "stdio" && resolveIdentityFromConfig(s, id) === "brainrouter") return id;
  }
  return null;
}
