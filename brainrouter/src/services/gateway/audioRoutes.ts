/**
 * Gateway audio data-plane — first-party speech-to-text (ADR-018 M1, ADR-035 D5/D7).
 *
 * BrainRouter serves the transcription model itself, so unlike the chat/responses
 * planes there is no upstream provider credential to resolve: the route simply
 * authenticates (the shared /v1 gateway auth already ran), forwards the raw audio
 * bytes to the internal Whisper STT sidecar at BRAINROUTER_STT_URL, and returns an
 * OpenAI-shaped `{ text }`. The sidecar is swappable behind one env var + one HTTP
 * contract, so whisper.cpp today can become faster-whisper later with no route
 * change. In the shipped stack the sidecar is `expose:`d to the compose network
 * only; the dev composes publish it on `127.0.0.1:3752` so it can be probed by
 * hand, which is loopback and not the LAN, but is not "never".
 *
 * Contract (ours; the desktop/dashboard are the clients): POST /v1/audio/transcriptions
 * with the raw audio body (Content-Type: audio/webm | audio/wav | audio/mpeg | …),
 * optional `?language=xx`. Returns `{ text }` (200) or an OpenAI error envelope.
 *
 * ## What this route OWNS, and why it is not just a proxy
 *
 * ADR-035 made transcription incremental: a meeting is now ~180 twenty-second
 * segments, each posted here, each retried from audio that is already on disk.
 * `packages/core`'s transcription queue decides whether a failed attempt costs a
 * retry, and it decides it FROM THE HTTP STATUS THIS ROUTE RETURNS — 408/429/
 * 502/503/504 mean "the endpoint declined to serve", so the attempt is refunded
 * (D7: an outage must not burn a good meeting's budget); every other status
 * means "this audio was rejected", so the attempt counts and the segment ends as
 * a stated gap (D5).
 *
 * That makes the status a load-bearing part of the contract rather than a
 * courtesy. Collapsing every non-2xx sidecar outcome into one 502 — which this
 * route used to do — tells the queue that undecodable bytes are an outage, and
 * an undecodable segment then retries forever: never a gap, never visible, and
 * re-uploading to our own sidecar every 60s until the meeting is discarded. So:
 *
 * - **A failure of the INPUT** (bytes ffmpeg cannot decode, an unsupported
 *   container, a body over the limit) is permanent for these bytes and answers
 *   in the 4xx class. Retrying it costs the user their retry budget and gains
 *   nothing.
 * - **A failure of the DEPENDENCY** (sidecar unreachable, misconfigured, out of
 *   capacity, wedged) is a fact about the server, not the audio, and stays
 *   502/503/504-class so the same bytes are tried again once it recovers.
 *
 * The bias when the evidence is thin is deliberately toward "dependency": a
 * mistaken outage only delays a gap, while a mistaken input failure destroys the
 * budget that would have recovered a real meeting.
 *
 * Nothing the sidecar says about itself — its message, its paths, its binaries —
 * ever reaches the response body. The client gets our fixed wording and a stable
 * code; the detail is for our logs.
 */
import express, { type Express, type NextFunction, type Request, type Response as ExpressResponse } from "express";
import { isPayloadTooLarge } from "../../api/bodyLimit.js";
import { sendOpenAiError, type GatewayDataPlaneService } from "./chatRoutes.js";

const DEFAULT_STT_URL = "http://127.0.0.1:3752";
const DEFAULT_AUDIO_BODY_LIMIT = "40mb";
const DEFAULT_STT_TIMEOUT_MS = 120_000;
/**
 * A ceiling on the ceiling. A typo'd env var (`BRAINROUTER_STT_TIMEOUT_MS=120000000`)
 * would otherwise pin a socket for a day and a half against a sidecar that is
 * never going to answer.
 */
const MAX_STT_TIMEOUT_MS = 900_000;
/** Enough of a sidecar error to classify it; short enough that a stack trace cannot flood a log line. */
const ERROR_DETAIL_LIMIT = 2_000;

function sttBaseUrl(): string {
  return (process.env.BRAINROUTER_STT_URL ?? DEFAULT_STT_URL).replace(/\/+$/, "");
}

/**
 * The largest body this route accepts, read at registration.
 *
 * Keep it at or below the sidecar's own `STT_MAX_BYTES` (80 MB): the sidecar
 * enforces its cap by destroying the connection, which reaches us as a transport
 * error and therefore reads as an outage. Refusing here instead is what turns
 * "too big" into the permanent, client-class answer it actually is.
 */
function audioBodyLimit(): string {
  const configured = process.env.BRAINROUTER_STT_MAX_BODY?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_AUDIO_BODY_LIMIT;
}

/**
 * How long to wait for the sidecar, per request.
 *
 * **Deliberately still 120s, even though a recorded segment is now ~20 seconds
 * of audio.** The same route carries ADR-035 D8's import path, where a user
 * really can hand us a 40 MB file in one piece and whisper.cpp on CPU takes
 * minutes to decode it; a bound sized for segments would turn every import into
 * a timeout. A segment that hangs is already bounded by something better than a
 * short deadline — the queue's in-flight cap holds the meeting to two
 * outstanding requests, and the audio it is waiting on is on disk either way.
 *
 * A deployment that serves only segments can tighten this with
 * `BRAINROUTER_STT_TIMEOUT_MS` (the existing knob, same style as
 * `BRAINROUTER_STT_MAX_BODY`) rather than a code change. Garbage, zero and
 * negative values fall back to the default: a `0` here would abort every request
 * instantly, which reads to every client as a permanently dead sidecar.
 */
function sttTimeoutMs(): number {
  const configured = Number.parseInt(process.env.BRAINROUTER_STT_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_STT_TIMEOUT_MS;
  return Math.min(configured, MAX_STT_TIMEOUT_MS);
}

/** One classified outcome: the status the client sees and the envelope that goes with it. */
interface SttFailure {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly message: string;
}

/**
 * The audio itself is the problem. 4xx — permanent for these bytes, so the
 * shared queue spends the attempt and the segment becomes a stated gap (D5)
 * rather than retrying against bytes that will never decode.
 */
const UNDECODABLE_AUDIO: SttFailure = {
  status: 422,
  type: "invalid_request_error",
  code: "stt_undecodable_audio",
  message: "The audio could not be decoded. Re-record or re-encode it (webm, wav, m4a and mp3 all work) and try again.",
};

/** Our own body cap. Same wording/code the standalone gateway's handler uses, so both mounts answer alike. */
const BODY_TOO_LARGE: SttFailure = {
  status: 413,
  type: "invalid_request_error",
  code: "request_too_large",
  message: "The request body is too large.",
};

/** The dependency is down, misconfigured, or not an STT service at all. Costs the caller no retry budget. */
const STT_UNAVAILABLE: SttFailure = {
  status: 502,
  type: "api_error",
  code: "stt_unavailable",
  message: "The transcription service is unavailable. The audio is unchanged — try again shortly.",
};

/** The dependency accepted the request and never finished it. Also an outage, and also refundable. */
const STT_TIMEOUT: SttFailure = {
  status: 504,
  type: "timeout_error",
  code: "stt_timeout",
  message: "The transcription service did not answer in time. The audio is unchanged — try again shortly.",
};

/** Capacity, not correctness. 429 is the one status a client can act on by simply waiting. */
const STT_RATE_LIMITED: SttFailure = {
  status: 429,
  type: "rate_limit_error",
  code: "stt_rate_limited",
  message: "The transcription service is rate limited. Try again shortly.",
};

/**
 * Machine-readable codes a sidecar may use to say "these bytes are not audio I
 * can decode", regardless of the status it chose. Checked first so a swapped
 * sidecar (faster-whisper, a hosted STT) can state the distinction outright
 * instead of leaving us to infer it from prose.
 */
const DECODE_FAILURE_CODES = new Set([
  "decode_failed",
  "invalid_audio",
  "undecodable_audio",
  "unsupported_audio",
  "unsupported_media_type",
]);

/**
 * Evidence, inside a sidecar 5xx, that the INPUT was rejected rather than the
 * service failing.
 *
 * The first-party sidecar transcodes with ffmpeg before whisper ever sees the
 * bytes, and reports a non-zero exit as a 500 (`deploy/stt/server.mjs`) — so
 * "this webm fragment has no decodable stream" and "the model file is missing"
 * arrive as the same status. `ffmpeg exited N` means the transcoder RAN and
 * refused these bytes, which is the input's fault; a spawn failure (`spawn
 * ffmpeg ENOENT`) never contains it, and stays an outage.
 *
 * The environment excuses are carved back out because ffmpeg also exits
 * non-zero when the sidecar's disk is full — a host problem that would
 * otherwise mark perfectly good audio as permanently undecodable.
 */
const FFMPEG_REJECTED_INPUT = /\bffmpeg\s+exited\b/i;
const FFMPEG_ENVIRONMENT_FAULT = /no space left|permission denied|cannot allocate|too many open files|read-only file system/i;

/** `{ code }`, `{ error: { code } }` or `{ error: "…" }` — whichever shape the sidecar chose. */
function errorCode(detail: string): string | undefined {
  try {
    const payload = JSON.parse(detail) as { code?: unknown; error?: unknown };
    if (typeof payload.code === "string" && payload.code.trim()) return payload.code.trim();
    const nested = payload.error;
    if (nested && typeof nested === "object" && typeof (nested as { code?: unknown }).code === "string") {
      const code = (nested as { code: string }).code.trim();
      if (code) return code;
    }
  } catch {
    // Not JSON, or not a shape we know. The prose heuristic is the fallback.
  }
  return undefined;
}

/**
 * Did the sidecar reject the AUDIO, or did the sidecar fail?
 *
 * An explicit code wins outright, including when it is one we do not recognise:
 * a sidecar that names its failure `model_missing` has told us this is not about
 * the bytes, and second-guessing it with a text match would be worse than
 * believing it.
 */
function rejectedTheAudio(detail: string): boolean {
  const code = errorCode(detail);
  if (code) return DECODE_FAILURE_CODES.has(code);
  return FFMPEG_REJECTED_INPUT.test(detail) && !FFMPEG_ENVIRONMENT_FAULT.test(detail);
}

/**
 * Map one sidecar response onto our contract.
 *
 * `MISCONFIGURED_STATUSES` are in the outage bucket on purpose even though they
 * are 4xx: every one of them means we are pointed at something that is not a
 * working STT service — a stale `BRAINROUTER_STT_URL`, a sidecar that has not
 * finished booting, a proxy answering in its place, an auth header we never
 * sent. That is precisely D7's case ("a meeting must never fail because a server
 * was down"): an operator fixes it and every queued segment drains from audio
 * that is still on disk. Charging the user's retry budget for OUR
 * misconfiguration would turn a fixable deployment mistake into permanent holes
 * in their transcript.
 */
const MISCONFIGURED_STATUSES = new Set([401, 403, 404, 405, 501]);

function classifySttResponse(status: number, detail: string): SttFailure {
  if (status === 413) return BODY_TOO_LARGE;
  if (status === 429) return STT_RATE_LIMITED;
  if (status === 408 || status === 504) return STT_TIMEOUT;
  if (MISCONFIGURED_STATUSES.has(status)) return STT_UNAVAILABLE;
  if (status < 500) return UNDECODABLE_AUDIO;
  return rejectedTheAudio(detail) ? UNDECODABLE_AUDIO : STT_UNAVAILABLE;
}

/**
 * Read enough of a failed response to classify it, and drain the rest.
 *
 * Leaving an error body unread holds the socket open against a service we are
 * about to be asked to call another 179 times.
 */
async function failureDetail(upstream: Response): Promise<string> {
  try {
    const body = await upstream.text();
    return body.slice(0, ERROR_DETAIL_LIMIT);
  } catch {
    return "";
  }
}

/** Our envelope out, the sidecar's words nowhere near it — they go to the log instead. */
function sendSttFailure(res: ExpressResponse, failure: SttFailure, detail?: string): void {
  console.error(`[provider-gateway] stt ${failure.code} (${failure.status})${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
  sendOpenAiError(res, failure.status, {
    message: failure.message,
    type: failure.type,
    param: null,
    code: failure.code,
  });
}

/**
 * Register POST /v1/audio/transcriptions onto an app that already has the gateway
 * /v1 auth middleware in front of it (so res.locals.gatewayAuth is set). Mounted
 * by BOTH the in-process brain mount and the standalone gateway process.
 */
export function registerGatewayAudioPlane(app: Express, _service?: GatewayDataPlaneService): void {
  // Capture the raw audio bytes for this route only (the global JSON parser skips
  // non-application/json bodies, so the audio stream is still intact here).
  app.use("/v1/audio/transcriptions", express.raw({ type: () => true, limit: audioBodyLimit() }));
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
      // Optional Whisper model select (HF ggml name, e.g. "small" / "large-v3"),
      // via ?model= or an x-model header; the sidecar maps it to a ggml file.
      const model = typeof req.query.model === "string" ? req.query.model
        : typeof req.headers["x-model"] === "string" ? req.headers["x-model"] : undefined;
      const controller = new AbortController();
      // Distinguishes OUR deadline from any other abort, so a timeout answers 504
      // (refundable) rather than being lumped in with a dead socket.
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, sttTimeoutMs());
      try {
        const upstream = await fetch(`${sttBaseUrl()}/inference`, {
          method: "POST",
          headers: { "content-type": contentType, ...(language ? { "x-language": language } : {}), ...(model ? { "x-model": model } : {}) },
          // Buffer is a valid fetch body at runtime; the cast sidesteps the TS 5.7
          // ArrayBufferLike/BodyInit strictness without copying the audio bytes.
          body: audio as unknown as BodyInit,
          signal: controller.signal,
        });
        if (!upstream.ok) {
          const detail = await failureDetail(upstream);
          const failure = classifySttResponse(upstream.status, detail);
          if (failure === STT_RATE_LIMITED) {
            // Pass the sidecar's own backoff through when it gave one, validated
            // the same way the chat plane validates it (a header we echo is a
            // header we own).
            const retryAfter = upstream.headers.get("retry-after");
            if (retryAfter && /^\d{1,6}$/.test(retryAfter)) res.setHeader("retry-after", retryAfter);
          }
          sendSttFailure(res, failure, `sidecar ${upstream.status} ${detail}`);
          return;
        }
        const payload = (await upstream.json().catch(() => ({}))) as { text?: unknown };
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        res.json({ text });
      } catch (error) {
        // Nothing answered: a refused connection, a reset socket, a DNS failure,
        // or our own deadline. All of them are the dependency, never the audio.
        sendSttFailure(res, timedOut ? STT_TIMEOUT : STT_UNAVAILABLE, error instanceof Error ? error.message : undefined);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  // Route-scoped, and registered here rather than left to the app: the standalone
  // gateway maps `entity.too.large` to this envelope but the brain's :3747 mount
  // does not, and a 40 MB import that answers 413-with-our-shape on one host and
  // something else on the other is exactly the "one host solved it" split
  // ADR-035 D1b exists to prevent. Anything else is still the app's to handle.
  app.use(
    "/v1/audio/transcriptions",
    (error: unknown, _req: Request, res: ExpressResponse, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      if (isPayloadTooLarge(error)) {
        sendSttFailure(res, BODY_TOO_LARGE);
        return;
      }
      next(error);
    },
  );
}
