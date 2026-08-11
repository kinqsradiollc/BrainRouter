/**
 * ADR-035 D10 — where this deployment's live transcription endpoint is, and
 * whether it is currently willing to be one.
 *
 * The seam in `server.ts` is off unless an operator points it somewhere, and
 * this module owns that decision so the adapter never has to. It follows the
 * conventions the batch route already established (`BRAINROUTER_STT_URL`,
 * `BRAINROUTER_STT_MAX_BODY`, `BRAINROUTER_STT_TIMEOUT_MS`): a deployment-level
 * network fact read from the server environment, with garbage falling back to
 * the safe answer rather than to a guess.
 *
 * ## Why the gate is a separate URL
 *
 * Not a boolean beside `BRAINROUTER_STT_URL`, because "which endpoint streams"
 * and "which endpoint transcribes a file" are genuinely two answers: the bundled
 * sidecar can do both, a hosted STT might do one. Naming the streaming endpoint
 * is therefore the opt-in AND the configuration, and forgetting it leaves
 * production exactly as it was — `streaming: null`, upgrades refused, batch
 * unchanged.
 *
 * ## Why the advertisement is probed, not assumed
 *
 * Golden rule 23: a fallback nobody can see is indistinguishable from working.
 * If the configured endpoint cannot confirm the streaming protocol right now,
 * this module answers with the honest segmented-only document, so a host is told
 * plainly which path it has instead of being handed a live promise that fails at
 * connect. Both answers are cached for the same short window, so recovery is
 * bounded and a probe cannot run per capability request.
 */
import {
  createStreamingTranscriptionCapabilities,
  MEETING_TRANSCRIPTION_LATENCY_MODES,
  SEGMENTED_TRANSCRIPTION_CAPABILITIES,
  type MeetingTranscriptionCapabilities,
  type MeetingTranscriptionLatencyMode,
} from "@kinqs/brainrouter-core/meetings";
import type { UpstreamTargetPolicy } from "@kinqs/brainrouter-core/provider";

import { fetchUpstreamWithPolicy } from "./upstreamPolicy.js";

/** The exact protocol `deploy/stt/stream.mjs` speaks. A different value is a different contract. */
export const GATEWAY_AUDIO_STREAM_PROTOCOL = "brainrouter.stt.stream.v1";

const DEFAULT_STREAM_TIMEOUT_MS = 15_000;
const MIN_STREAM_TIMEOUT_MS = 1_000;
const MAX_STREAM_TIMEOUT_MS = 120_000;
/** Short enough that a recovered endpoint is advertised within seconds; long enough that a probe is not per request. */
const CAPABILITY_CACHE_MS = 10_000;
/** A capability document is a few hundred bytes; anything larger is not one. */
const MAX_CAPABILITY_BYTES = 8_192;

export interface GatewayAudioStreamingEndpoint {
  /** Exact origin, no path — the shape `validateUpstreamTarget` will accept as its own allowlist entry. */
  readonly origin: string;
  readonly streamPath: string;
  readonly capabilitiesPath: string;
  readonly timeoutMs: number;
  readonly policy: UpstreamTargetPolicy;
}

function boundedTimeoutMs(raw: string | undefined): number {
  const configured = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_STREAM_TIMEOUT_MS;
  return Math.min(Math.max(configured, MIN_STREAM_TIMEOUT_MS), MAX_STREAM_TIMEOUT_MS);
}

/**
 * Resolve the configured endpoint, or `null` when this deployment has not opted
 * in. A value that is set but unusable also returns `null` — with a log line,
 * because a typo that silently enabled nothing would be indistinguishable from
 * the gate being off.
 */
export function resolveGatewayAudioStreamingEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): GatewayAudioStreamingEndpoint | null {
  const configured = env.BRAINROUTER_STT_STREAM_URL?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    console.error("[provider-gateway] BRAINROUTER_STT_STREAM_URL is not a valid URL; streaming stays disabled.");
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    console.error("[provider-gateway] BRAINROUTER_STT_STREAM_URL must be a bare http(s) origin; streaming stays disabled.");
    return null;
  }
  const base = url.pathname.replace(/\/+$/, "");
  return Object.freeze({
    origin: url.origin,
    streamPath: `${base}/stream`,
    capabilitiesPath: `${base}/stream/capabilities`,
    timeoutMs: boundedTimeoutMs(env.BRAINROUTER_STT_STREAM_TIMEOUT_MS),
    // The operator naming this origin IS the deployment declaring it, exactly as
    // BRAINROUTER_UPSTREAM_ALLOWLIST works for provider probes. What the policy
    // buys here is the rest of it: no credentials in the URL, no cloud-metadata
    // or multicast target, and DNS pinned to the addresses validated for this
    // call so the sidecar's name cannot be re-pointed between check and connect.
    policy: Object.freeze({ mode: "self-hosted", allowlist: Object.freeze([url.origin]) }) as UpstreamTargetPolicy,
  });
}

function latencyModes(value: unknown): readonly MeetingTranscriptionLatencyMode[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MEETING_TRANSCRIPTION_LATENCY_MODES.length) {
    return null;
  }
  const modes = new Set<MeetingTranscriptionLatencyMode>();
  for (const entry of value) {
    if (!MEETING_TRANSCRIPTION_LATENCY_MODES.includes(entry as MeetingTranscriptionLatencyMode)) return null;
    modes.add(entry as MeetingTranscriptionLatencyMode);
  }
  return modes.size === value.length ? [...modes] : null;
}

/**
 * Ask the endpoint what it offers and translate that into Core's document.
 *
 * The endpoint advertises only its own protocol name and its latency modes; the
 * rest of the D10 promise — persistent sessions, partial results, server-owned
 * boundaries, coverage checkpoints, resumability, segmented fallback — is the
 * ADAPTER's to keep, and the adapter is what keeps it. Claiming those on behalf
 * of an endpoint that merely answered a GET is exactly the "merely having an
 * adapter object is not a capability" mistake `audio-capabilities.ts` refuses.
 */
export async function probeGatewayAudioStreamingCapabilities(
  endpoint: GatewayAudioStreamingEndpoint,
): Promise<MeetingTranscriptionCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  try {
    const response = await fetchUpstreamWithPolicy(
      `${endpoint.origin}${endpoint.capabilitiesPath}`,
      { method: "GET", headers: { accept: "application/json" }, signal: controller.signal },
      endpoint.policy,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
    }
    const body = (await response.text()).slice(0, MAX_CAPABILITY_BYTES);
    const advertised = JSON.parse(body) as { protocol?: unknown; latencyModes?: unknown };
    if (advertised?.protocol !== GATEWAY_AUDIO_STREAM_PROTOCOL) return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
    const modes = latencyModes(advertised.latencyModes);
    if (!modes) return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
    return createStreamingTranscriptionCapabilities(modes);
  } catch {
    // Unreachable, slow, not JSON, not this protocol: all the same answer, which
    // is the one the host can act on.
    return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
  } finally {
    clearTimeout(timer);
  }
}

/** One in-flight probe per gateway, with a bounded cache in both directions. */
export function createGatewayAudioCapabilityCache(
  endpoint: GatewayAudioStreamingEndpoint,
  now: () => number = Date.now,
  probe = probeGatewayAudioStreamingCapabilities,
): () => Promise<MeetingTranscriptionCapabilities> {
  let cached: MeetingTranscriptionCapabilities | null = null;
  let cachedAt = 0;
  let inFlight: Promise<MeetingTranscriptionCapabilities> | null = null;
  return async () => {
    const at = now();
    if (cached && at - cachedAt < CAPABILITY_CACHE_MS && at >= cachedAt) return cached;
    inFlight ??= probe(endpoint)
      .then((result) => {
        cached = result;
        cachedAt = now();
        return result;
      })
      .catch(() => SEGMENTED_TRANSCRIPTION_CAPABILITIES)
      .finally(() => {
        inFlight = null;
      });
    return await inFlight;
  };
}
