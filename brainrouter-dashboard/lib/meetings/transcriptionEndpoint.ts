/**
 * ADR-035 D10 — what THIS deployment's transcription endpoint says it can do,
 * asked at runtime rather than assumed at build time.
 *
 * The strategy is a property of the ENDPOINT, not of the host (D10), so the
 * dashboard may not decide it. It asks, and it asks the same authenticated
 * gateway route the batch POST already goes to — `/v1/audio/transcriptions` and
 * `/v1/audio/transcriptions/capabilities` are the same origin and the same auth
 * gate, so a browser that can transcribe can also discover.
 *
 * **Every unhappy answer is the segmented document.** A 404 from an older
 * gateway, a 401, an HTML error page, a body that is not the exact v1 contract,
 * a network that is not there — all of them mean the same thing to a host: use
 * the path that is proven. `describeTranscriptionEndpoint` is Core's single
 * strict normalizer and the only thing here that decides what a document means;
 * this module contributes the request and nothing else, so a permissive reader
 * cannot appear on one host and not the other.
 *
 * Production today advertises `streaming: null`, and that answer must leave the
 * dashboard behaving exactly as it does now — one POST per transcription unit.
 */
import {
  describeTranscriptionEndpoint,
  SEGMENTED_TRANSCRIPTION_CAPABILITIES,
  type MeetingTranscriptionCapabilities,
} from "@kinqs/brainrouter-core/meetings";

/** The gateway's authenticated capability route (`audio-capabilities.ts`). */
export const MEETING_CAPABILITIES_PATH = "/v1/audio/transcriptions/capabilities";

/** The gateway's persistent-audio upgrade route (`audio-streaming-protocol.ts`). */
export const MEETING_STREAM_PATH = "/v1/audio/transcriptions/stream";

export interface TranscriptionEndpointOptions {
  readonly baseUrl: string;
  /** JWT or API key; absent on an unauthenticated dev origin. */
  readonly token?: string;
  /** The workspace this recording belongs to, so a tenant's answer is that tenant's. */
  readonly orgId?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Ask the endpoint, and fail closed.
 *
 * Never throws: a capability probe that could refuse a recording would make
 * discovery a new way to lose a meeting, which is the opposite of the point.
 */
export async function describeMeetingTranscriptionEndpoint(
  options: TranscriptionEndpointOptions,
): Promise<MeetingTranscriptionCapabilities> {
  const call = options.fetchImpl ?? fetch;
  try {
    const response = await call(`${options.baseUrl}${MEETING_CAPABILITIES_PATH}`, {
      method: "GET",
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.orgId ? { "X-BrainRouter-Org": options.orgId } : {}),
      },
    });
    if (!response.ok) return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
    // Core's normalizer is handed the parsed body directly. Nothing is read out
    // of it here, because a field read here is a field this host could come to
    // interpret differently from the other one.
    return describeTranscriptionEndpoint(await response.json());
  } catch {
    return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
  }
}

/**
 * The WebSocket URL for the same origin the batch POST uses.
 *
 * The gateway refuses an upgrade carrying any query string, so this is a path
 * and nothing else — the bearer travels in the first frame, never in the URL,
 * which is also why it is not a query parameter here (golden rule: no
 * credentials in a URL a proxy log can keep).
 */
export function meetingStreamUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}${MEETING_STREAM_PATH}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}${MEETING_STREAM_PATH}`;
  return `${trimmed}${MEETING_STREAM_PATH}`;
}
