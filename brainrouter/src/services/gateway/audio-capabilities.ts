/**
 * ADR-035 D10 — authenticated transcription capability discovery boundary.
 *
 * A capability response is a promise both hosts act on, so this boundary uses
 * Core's single strict normalizer. Missing, throwing, partial, or unfamiliar
 * advertisements all become the honest segmented-only document — including when
 * an adapter IS injected but its endpoint cannot currently confirm the protocol,
 * because merely having a WebSocket adapter object is not a capability.
 */
import type { Express, Response as ExpressResponse } from "express";

import {
  describeTranscriptionEndpoint,
  SEGMENTED_TRANSCRIPTION_CAPABILITIES,
  type MeetingTranscriptionCapabilities,
} from "@kinqs/brainrouter-core/meetings";

import type { GatewayAuthContext } from "./auth.js";
import type { GatewayAudioStreamingPort } from "./audio-streaming-protocol.js";

export const GATEWAY_AUDIO_CAPABILITIES_PATH = "/v1/audio/transcriptions/capabilities";

function authContext(res: ExpressResponse): GatewayAuthContext {
  return res.locals.gatewayAuth as GatewayAuthContext;
}

/** Resolve one tenant's advertisement without ever returning adapter detail. */
export async function gatewayAudioCapabilities(
  port: GatewayAudioStreamingPort | undefined,
  auth: GatewayAuthContext,
): Promise<MeetingTranscriptionCapabilities> {
  if (!port) return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
  try {
    return describeTranscriptionEndpoint(await port.capabilities(auth));
  } catch {
    return SEGMENTED_TRANSCRIPTION_CAPABILITIES;
  }
}

/** Register the normalized GET behind the gateway's existing /v1 auth gate. */
export function registerGatewayAudioCapabilities(app: Express, port?: GatewayAudioStreamingPort): void {
  app.get(GATEWAY_AUDIO_CAPABILITIES_PATH, async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(await gatewayAudioCapabilities(port, authContext(res)));
  });
}
