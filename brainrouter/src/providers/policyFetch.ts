import { validateUpstreamTarget, type UpstreamTargetPolicy } from "@kinqs/brainrouter-core/provider";
import { upstreamProbePolicy } from "./upstreamProbePolicy.js";

/**
 * ADR-039 — a transport that refuses an internal target before dialing, for the
 * memory-pipeline provider calls (embeddings, rerank, cognitive-extraction chat)
 * that dial an ORG-CONFIGURED endpoint. Without it, an org pointing its embedding/
 * rerank/cognition provider at an internal address turns every recall/capture into
 * a server-side request to that host (SSRF: cloud metadata, docker-internal
 * services, loopback).
 *
 * In hosted mode (the fail-closed default) loopback / RFC1918 / 169.254.169.254 are
 * refused with a clear `UpstreamPolicyError`; a self-hosted deployment names its
 * local backends via `BRAINROUTER_UPSTREAM_ALLOWLIST` — the SAME contract the model
 * probe and provider gateway already use.
 *
 * Unlike the gateway/probe path this VALIDATES the resolved target but does not pin
 * the connection dispatcher: the memory-pipeline transport must stay a plain fetch
 * so `fetchWithExternalRetry`'s retry/backoff and its fetch-stubbing unit tests keep
 * working. That leaves a narrow DNS-rebinding TOCTOU window (validate resolves a
 * public IP, a re-resolve at fetch time returns an internal one) — a documented
 * follow-up; the primary threat (a provider configured at an internal address) is
 * closed. Pass the result as the `fetchImpl` arg of `fetchWithExternalRetry`.
 */
export function policyBoundFetch(
  policy: UpstreamTargetPolicy = upstreamProbePolicy(),
): (input: string | URL | Request, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    await validateUpstreamTarget(url, policy); // throws UpstreamPolicyError on an internal target
    return fetch(url, init);
  };
}
