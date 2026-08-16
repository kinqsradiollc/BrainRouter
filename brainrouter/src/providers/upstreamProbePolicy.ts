/**
 * The network policy every provider probe runs under.
 *
 * `baseUrl` on the probe routes comes straight from an admin request body, and
 * before this the probes used bare `fetch` — so an admin could point them at
 * `169.254.169.254`, a docker-internal service, or any RFC1918 address, and the
 * GET variant returned the response body. That is SSRF with a read.
 *
 * Hosted is the default because the safe answer must be the one you get by
 * forgetting to configure anything. But refusing loopback outright would break a
 * legitimate, supported workflow — self-hosters running Ollama or LM Studio on
 * 127.0.0.1 — so a deployment opts in by naming EXACT origins:
 *
 *   BRAINROUTER_UPSTREAM_ALLOWLIST=http://127.0.0.1:11434,http://127.0.0.1:1234
 *
 * Exact origins only: no paths, no wildcards, no bare hostnames. The allowlist
 * is a statement about which servers this deployment runs, not a pattern an
 * attacker can satisfy — and `validateUpstreamTarget` enforces that shape,
 * rejecting an entry with a path, query or fragment rather than interpreting it.
 *
 * A deployment-level network boundary, so it is read from the server
 * environment rather than `cli.*` in config.json: it describes the host the
 * brain runs on, not a user's preference.
 */
import type { UpstreamTargetPolicy } from "@kinqs/brainrouter-core/provider";

export function upstreamProbePolicy(env: NodeJS.ProcessEnv = process.env): UpstreamTargetPolicy {
  const raw = env.BRAINROUTER_UPSTREAM_ALLOWLIST?.trim();
  if (!raw) return {};
  const allowlist = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowlist.length === 0) return {};
  return { mode: "self-hosted", allowlist };
}
