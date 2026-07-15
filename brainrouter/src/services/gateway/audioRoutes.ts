/**
 * Gateway audio data-plane — first-party speech-to-text (ADR-018 M1).
 *
 * BrainRouter serves the transcription model itself, so unlike the chat/responses
 * planes there is no upstream provider credential to resolve: the route simply
 * authenticates (the shared /v1 gateway auth already ran), forwards the raw audio
 * bytes to the internal Whisper STT sidecar at BRAINROUTER_STT_URL, and returns an
 * OpenAI-shaped `{ text }`. The sidecar is swappable behind one env var + one HTTP
 * contract, so whisper.cpp today can become faster-whisper later with no route
 * change. The sidecar is never exposed to the host — only :3747 is.
 *
 * Contract (ours; the desktop/dashboard are the clients): POST /v1/audio/transcriptions
 * with the raw audio body (Content-Type: audio/webm | audio/wav | audio/mpeg | …),
 * optional `?language=xx`. Returns `{ text }` (200) or an OpenAI error envelope.
 */
import express, { type Express, type Request, type Response as ExpressResponse } from "express";
import { sendOpenAiError, type GatewayDataPlaneService } from "./chatRoutes.js";

const DEFAULT_STT_URL = "http://127.0.0.1:3752";
const AUDIO_BODY_LIMIT = process.env.BRAINROUTER_STT_MAX_BODY ?? "40mb";
const STT_TIMEOUT_MS = Number.parseInt(process.env.BRAINROUTER_STT_TIMEOUT_MS ?? "120000", 10);

function sttBaseUrl(): string {
  return (process.env.BRAINROUTER_STT_URL ?? DEFAULT_STT_URL).replace(/\/+$/, "");
}

/**
 * Register POST /v1/audio/transcriptions onto an app that already has the gateway
 * /v1 auth middleware in front of it (so res.locals.gatewayAuth is set). Mounted
 * by BOTH the in-process brain mount and the standalone gateway process.
 */
export function registerGatewayAudioPlane(app: Express, _service?: GatewayDataPlaneService): void {
  // Capture the raw audio bytes for this route only (the global JSON parser skips
  // non-application/json bodies, so the audio stream is still intact here).
  app.use("/v1/audio/transcriptions", express.raw({ type: () => true, limit: AUDIO_BODY_LIMIT }));
  app.post(
    "/v1/audio/transcriptions",
    async (req: Request, res: ExpressResponse) => {
      const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (audio.length === 0) {
        sendOpenAiError(res, 400, { message: "No audio was provided.", type: "invalid_request_error", param: "file", code: "missing_audio" });
        return;
      }
      const contentType = (req.headers["content-type"] as string | undefined) || "application/octet-stream";
      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number.isFinite(STT_TIMEOUT_MS) ? STT_TIMEOUT_MS : 120000);
      try {
        const upstream = await fetch(`${sttBaseUrl()}/inference`, {
          method: "POST",
          headers: { "content-type": contentType, ...(language ? { "x-language": language } : {}) },
          // Buffer is a valid fetch body at runtime; the cast sidesteps the TS 5.7
          // ArrayBufferLike/BodyInit strictness without copying the audio bytes.
          body: audio as unknown as BodyInit,
          signal: controller.signal,
        });
        if (!upstream.ok) {
          sendOpenAiError(res, 502, { message: "The transcription service is unavailable.", type: "api_error", param: null, code: "stt_unavailable" });
          return;
        }
        const payload = (await upstream.json().catch(() => ({}))) as { text?: unknown };
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        res.json({ text });
      } catch {
        sendOpenAiError(res, 502, { message: "Transcription failed. Check the STT service and try again.", type: "api_error", param: null, code: "stt_error" });
      } finally {
        clearTimeout(timer);
      }
    },
  );
}
