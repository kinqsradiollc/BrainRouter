/**
 * BrainRouter Whisper STT sidecar — live streaming transcription (ADR-035 D10).
 *
 * ## Why this shape and not another
 *
 * whisper.cpp has no streaming decoder. Its `whisper-stream` example is an SDL
 * microphone demo — it opens a capture device and prints to a terminal — so it
 * is not something a server can front. `whisper-server` keeps a model resident
 * but still answers one finished file per request. What every server-side
 * "live whisper" ends up doing is the same loop, and it is the loop below:
 *
 *   accumulate PCM → re-decode a BOUNDED trailing window on a tick → emit the
 *   current hypothesis as a partial → when a segment is far enough behind the
 *   live edge to stop changing, commit it and slide the window past it.
 *
 * Re-decoding is what buys refinement: the same words are decoded again with
 * more right-hand context each tick, so "recognise" becomes "recognised the"
 * rather than being frozen at the first guess. Sliding is what bounds the cost —
 * without a commit boundary the window would grow with the meeting and the
 * decode would get slower exactly as the meeting got more valuable.
 *
 * The pinned engine (`WHISPER_CPP_REF=v1.7.4`) has no voice-activity detection
 * built in — `--vad` arrived later — so the boundary here is not a VAD decision.
 * It is whisper's own segmentation (`-oj` gives per-segment `offsets.from/to` in
 * ms) plus one rule: a segment that ends more than `commitMs` before the live
 * edge will not be revised, so it is final. That is a server-owned boundary
 * decided by the decoder's own segmentation rather than by the caller's clock,
 * which is what the D10 capability contract promises.
 *
 * ## The trade-off is a setting, not a constant
 *
 * A shorter tick and a shorter commit lookback mean text sooner and more
 * revisions; a longer window and a wider beam mean better text later. That is a
 * genuine curve and no single point on it is right for every deployment, so it
 * is exposed as the contract's named latency modes (`STT_STREAM_MODES` chooses
 * which this deployment offers) with `STT_STREAM_MIN_TICK_MS` as the floor a
 * small box needs to shift the whole curve without erasing the modes.
 *
 * ## Dependency-free, deliberately
 *
 * Both `server.mjs` and the Dockerfile state that this service has no npm
 * dependencies, so the transport is HTTP/1.1 full duplex over `node:http` rather
 * than a WebSocket: the request body is the container byte stream (exactly what
 * ffmpeg wants on stdin, so no framing layer exists to get wrong), and the
 * response is chunked NDJSON events written while that body is still arriving.
 * One long-lived ffmpeg per stream does the demux/decode to 16 kHz mono PCM;
 * short-lived `whisper-cli` runs do each window, which is the same invocation
 * the batch path already proves.
 *
 * ## Wire contract (ours; the gateway adapter is the only client)
 *
 * `GET  /stream/capabilities` → `{ protocol, latencyModes }`
 * `POST /stream`  request: container bytes (chunked), `x-latency-mode`,
 *                 optional `x-model` / `x-language`; ending the body means
 *                 end-of-audio.
 *                 response: `application/x-ndjson`, one event per line —
 *                   `{ type: "partial"|"final", utteranceId, startMs, endMs, text }`
 *                   `{ type: "committed", throughMs }`
 *                   `{ type: "error", code }`
 * Times are milliseconds from the first sample THIS connection received; the
 * caller owns the mapping back onto its own durable timeline. `error` carries a
 * machine code and never prose: `undecodable_audio` means these bytes will never
 * decode, anything else means this service failed and the same bytes are worth
 * retrying.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STREAM_PROTOCOL = "brainrouter.stt.stream.v1";

const SAMPLE_RATE = 16_000;
/** 16 kHz × mono × 16-bit = exactly 32 bytes per millisecond, so ms↔bytes is lossless. */
const BYTES_PER_MS = 32;
const WAV_HEADER_BYTES = 44;
/** Enough of ffmpeg's stderr to classify the failure; short enough not to flood a log line. */
const ERROR_DETAIL_LIMIT = 2_000;
/** A decoded window cannot legitimately contain this many segments; a malformed JSON might. */
const MAX_SEGMENTS = 512;
const MAX_SEGMENT_CHARS = 4_000;
/**
 * One emitted utterance. A window is bounded, so a legitimate one is a few
 * hundred characters; this keeps a decoder that repeats itself from producing a
 * line no reader will accept.
 */
const MAX_UTTERANCE_CHARS = 8_000;
/** Consecutive whisper failures tolerated before the stream gives up on the decoder. */
const MAX_DECODE_FAILURES = 3;
/** Events are tiny; a peer that has stopped reading this much of them is gone. */
const MAX_PENDING_EVENT_BYTES = 1024 * 1024;

/**
 * Named points on the latency/accuracy curve.
 *
 * `tickMs` — how often the trailing window is re-decoded (how often text moves).
 * `commitMs` — how far behind the live edge a segment must end before it is
 *   treated as settled. Too small and finals get revised, which the contract
 *   forbids; too large and settled text arrives late.
 * `maxWindowMs` — the ceiling on re-decode cost. Reaching it forces a commit
 *   even though no boundary arrived, which is the bounded fallback the strategy
 *   contract expects rather than an unbounded window.
 * `beam` — beam size and best-of. 1 is greedy (plus `-nf`, no temperature
 *   fallback) and is the difference between keeping up and not on a small box.
 */
const PROFILES = Object.freeze({
  "low-latency": Object.freeze({ tickMs: 900, commitMs: 1_500, maxWindowMs: 10_000, beam: 1 }),
  balanced: Object.freeze({ tickMs: 1_800, commitMs: 2_500, maxWindowMs: 18_000, beam: 2 }),
  "high-accuracy": Object.freeze({ tickMs: 3_500, commitMs: 4_000, maxWindowMs: 28_000, beam: 5 }),
});

function boundedInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

/** Which modes this deployment offers, in the contract's own order. Unknown names are dropped. */
export function streamLatencyModes(env = process.env) {
  const configured = (env.STT_STREAM_MODES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const offered = configured.length > 0
    ? Object.keys(PROFILES).filter((mode) => configured.includes(mode))
    : Object.keys(PROFILES);
  return offered.length > 0 ? offered : Object.keys(PROFILES);
}

export function streamCapabilities(env = process.env) {
  return { protocol: STREAM_PROTOCOL, latencyModes: streamLatencyModes(env) };
}

function profileFor(mode, env = process.env) {
  if (!streamLatencyModes(env).includes(mode)) return null;
  const base = PROFILES[mode];
  const floor = boundedInt(env.STT_STREAM_MIN_TICK_MS, 0, 0, 10_000);
  return { ...base, tickMs: Math.max(base.tickMs, floor) };
}

/** A 16 kHz mono 16-bit PCM WAV around already-decoded samples. whisper-cli reads files, not pipes. */
function wavAround(pcm) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * whisper's own segmentation for one window, in ms from the window start.
 *
 * Anything that is not the exact `-oj` shape yields no segments rather than a
 * guess, and bracketed-only text (`[BLANK_AUDIO]`, `(silence)`) is dropped —
 * those are decoder annotations, not something a person said.
 */
function parseWindowSegments(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const transcription = payload?.transcription;
  if (!Array.isArray(transcription) || transcription.length > MAX_SEGMENTS) return null;
  const segments = [];
  for (const entry of transcription) {
    const from = entry?.offsets?.from;
    const to = entry?.offsets?.to;
    const text = typeof entry?.text === "string" ? entry.text.trim().slice(0, MAX_SEGMENT_CHARS) : "";
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < 0) continue;
    if (!text || /^[[(][^\])]{0,64}[\])]$/.test(text)) continue;
    segments.push({ startMs: Math.round(from), endMs: Math.round(to), text });
  }
  return segments;
}

/**
 * One live transcription stream.
 *
 * `run` and `resolveModelPath` are injected by `server.mjs` so the batch path
 * and this one execute whisper through exactly one helper: a difference between
 * how the two paths invoke the engine would be a difference in what they
 * transcribe.
 */
export function createStreamHandler({ run, resolveModelPath, whisperBin, threads, env = process.env }) {
  const maxSessions = boundedInt(env.STT_STREAM_MAX_SESSIONS, 2, 1, 64);
  const maxBytes = boundedInt(env.STT_STREAM_MAX_BYTES, 512 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024);
  const maxMs = boundedInt(env.STT_STREAM_MAX_MS, 6 * 60 * 60_000, 60_000, 24 * 60 * 60_000);
  let active = 0;

  return function handleStream(req, res) {
    const mode = String(req.headers["x-latency-mode"] ?? "");
    const profile = profileFor(mode, env);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      req.destroy();
    };
    if (!profile) { json(400, { error: "unsupported latency mode", code: "unsupported_latency_mode" }); return; }
    if (active >= maxSessions) { json(429, { error: "too many streams", code: "stream_capacity" }); return; }

    const rawLanguage = req.headers["x-language"];
    const language = typeof rawLanguage === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(rawLanguage)
      ? rawLanguage.split("-")[0].toLowerCase()
      : "";
    const modelPath = resolveModelPath(req.headers["x-model"]);

    active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };

    // Decoded PCM, kept only from the current window start. `absoluteStartByte`
    // is where buffers[0] sits on the stream's byte timeline, so trimming is a
    // shift rather than a copy of the meeting so far.
    let buffers = [];
    let absoluteStartByte = 0;
    let absoluteEndByte = 0;
    let windowStartMs = 0;
    let utteranceStartMs = 0;
    let utteranceIndex = 0;
    let decoding = false;
    let decodeFailures = 0;
    let finished = false;
    let ended = false;
    let ffmpegProduced = 0;
    let stderr = "";
    let timer;
    let workdir = "";

    const emit = (event) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > MAX_PENDING_EVENT_BYTES) { stop("dependency"); return; }
      res.write(`${JSON.stringify(event)}\n`);
    };

    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        // A live container is probed as it arrives; ffmpeg's 5 MB / 5 s defaults
        // would hold the first PCM back by seconds, which is the whole point of
        // this route. A webm/ogg header plus its first packets fit comfortably.
        "-analyzeduration", "500000", "-probesize", "131072",
        "-i", "pipe:0",
        "-vn", "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le",
        "-flush_packets", "1", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    /** End the stream. `input` says these bytes will never decode; anything else is ours to fix. */
    const stop = (kind) => {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      release();
      try { ffmpeg.kill("SIGKILL"); } catch { /* already gone */ }
      if (!res.writableEnded) {
        if (kind) res.write(`${JSON.stringify({ type: "error", code: kind === "input" ? "undecodable_audio" : "decoder_failed" })}\n`);
        res.end();
      }
      if (workdir) void rm(workdir, { recursive: true, force: true }).catch(() => {});
    };

    ffmpeg.on("error", (error) => {
      console.error("[stt] stream decoder failed to start:", error instanceof Error ? error.message : error);
      // Never started is a fact about this service, so it answers before the
      // NDJSON stream exists: a status the caller can classify without parsing.
      if (!res.headersSent) json(503, { error: "decoder unavailable", code: "decoder_unavailable" });
      stop("dependency");
    });
    ffmpeg.stderr.on("data", (data) => { stderr = (stderr + data).slice(-ERROR_DETAIL_LIMIT); });
    ffmpeg.stdout.on("data", (data) => {
      ffmpegProduced += data.length;
      buffers.push(data);
      absoluteEndByte += data.length;
      if (absoluteEndByte > maxBytes || absoluteEndByte / BYTES_PER_MS > maxMs) stop("dependency");
    });

    /**
     * ffmpeg RAN and refused these bytes → the input is the problem; it never
     * started, or the host it runs on is broken → the dependency is.
     *
     * This mirrors the batch route's rule so both surfaces classify the same
     * bytes the same way, and the residual risk is inverted here in the safe
     * direction: a wrong "input" verdict downgrades the caller to the mandatory
     * segmented path, which re-classifies those bytes itself, while a wrong
     * "dependency" verdict is an unbounded reconnect loop against audio that
     * will never decode.
     */
    const ENVIRONMENT_FAULT = /no space left|permission denied|cannot allocate|too many open files|read-only file system/i;
    ffmpeg.on("close", (code) => {
      if (ended) return;
      if (code === 0 || (finished && ffmpegProduced > 0)) { void drain().catch(() => stop("dependency")); return; }
      console.error(`[stt] stream decoder exited ${code}: ${stderr.replace(/\s+/g, " ").slice(0, 300)}`);
      stop(ENVIRONMENT_FAULT.test(stderr) ? "dependency" : "input");
    });

    const producedMs = () => Math.floor(absoluteEndByte / BYTES_PER_MS);

    /** Drop everything before the window start; only the window is ever decoded or held. */
    const windowPcm = () => {
      const target = windowStartMs * BYTES_PER_MS;
      while (buffers.length > 0 && absoluteStartByte + buffers[0].length <= target) {
        absoluteStartByte += buffers[0].length;
        buffers.shift();
      }
      if (buffers.length > 0 && absoluteStartByte < target) {
        buffers[0] = buffers[0].subarray(target - absoluteStartByte);
        absoluteStartByte = target;
      }
      const pcm = Buffer.concat(buffers);
      buffers = pcm.length > 0 ? [pcm] : [];
      return pcm;
    };

    const decodeWindow = async (pcm) => {
      const base = join(workdir, "window");
      await unlink(`${base}.json`).catch(() => {});
      await unlink(`${base}.wav.json`).catch(() => {});
      await writeFile(`${base}.wav`, wavAround(pcm));
      const args = [
        "-m", modelPath, "-f", `${base}.wav`, "-oj", "-of", base, "-np",
        "-t", threads, "-bs", String(profile.beam), "-bo", String(profile.beam),
      ];
      if (profile.beam <= 1) args.push("-nf");
      if (language) args.push("-l", language);
      await run(whisperBin, args);
      // `-of` names the output base, but read the input-derived name too so a
      // build that ignores it still produces text instead of a decoder failure.
      const raw = await readFile(`${base}.json`, "utf8").catch(() => readFile(`${base}.wav.json`, "utf8"));
      return parseWindowSegments(raw);
    };

    /**
     * One pass: decode the window, seal what has stopped changing, and publish
     * the rest as the current hypothesis.
     *
     * `sealAll` is the end of audio, where nothing is unstable any more.
     */
    const pass = async (sealAll) => {
      const pcm = windowPcm();
      const windowEndMs = windowStartMs + Math.floor(pcm.length / BYTES_PER_MS);
      if (windowEndMs <= windowStartMs) return;
      const segments = await decodeWindow(pcm);
      if (segments === null) throw new Error("window decode produced no readable result");
      decodeFailures = 0;
      const absolute = segments.map((segment) => ({
        startMs: windowStartMs + segment.startMs,
        endMs: Math.min(windowEndMs, windowStartMs + segment.endMs),
        text: segment.text,
      })).filter((segment) => segment.endMs > segment.startMs);

      const stableThroughMs = sealAll ? windowEndMs : windowEndMs - profile.commitMs;
      let settled = absolute.filter((segment) => segment.endMs <= stableThroughMs);
      // No boundary arrived and the window has hit its ceiling: seal what is
      // there rather than let re-decode cost grow with the meeting.
      if (settled.length === 0 && absolute.length > 0 && windowEndMs - windowStartMs >= profile.maxWindowMs) {
        settled = absolute;
      }

      if (settled.length > 0) {
        const endMs = settled[settled.length - 1].endMs;
        if (endMs > utteranceStartMs) {
          emit({
            type: "final",
            utteranceId: `u${utteranceIndex}`,
            startMs: utteranceStartMs,
            endMs,
            text: settled.map((segment) => segment.text).join(" ").trim().slice(0, MAX_UTTERANCE_CHARS),
          });
          emit({ type: "committed", throughMs: endMs });
          windowStartMs = endMs;
          utteranceStartMs = endMs;
          utteranceIndex += 1;
        }
      } else if (absolute.length === 0 && stableThroughMs > utteranceStartMs) {
        // Silence is coverage: nothing was said through here and nothing will be
        // revised, so the caller may advance its durable checkpoint past it.
        emit({ type: "committed", throughMs: stableThroughMs });
        windowStartMs = stableThroughMs;
        utteranceStartMs = stableThroughMs;
      }

      const tail = absolute.filter((segment) => segment.endMs > windowStartMs);
      if (tail.length > 0 && windowEndMs > utteranceStartMs) {
        emit({
          type: "partial",
          utteranceId: `u${utteranceIndex}`,
          startMs: utteranceStartMs,
          endMs: windowEndMs,
          text: tail.map((segment) => segment.text).join(" ").trim().slice(0, MAX_UTTERANCE_CHARS),
        });
      }
    };

    const tick = async (sealAll = false) => {
      if (decoding || ended) return;
      decoding = true;
      try {
        await pass(sealAll);
      } catch (error) {
        decodeFailures += 1;
        console.error(`[stt] stream window decode failed (${decodeFailures}):`, error instanceof Error ? error.message : error);
        // A transient exec failure must not cost a meeting: skip this tick and
        // keep the connection, and only give up once it is clearly not transient.
        if (decodeFailures >= MAX_DECODE_FAILURES) stop("dependency");
      } finally {
        decoding = false;
      }
    };

    /** End of audio: wait for any in-flight window, seal the remainder, then close. */
    const drain = async () => {
      while (decoding) await new Promise((resolve) => setTimeout(resolve, 25));
      if (ended) return;
      await tick(true);
      if (ended) return;
      const totalMs = producedMs();
      if (totalMs > utteranceStartMs) emit({ type: "committed", throughMs: totalMs });
      stop(null);
    };

    req.on("aborted", () => stop(null));
    req.on("error", () => stop(null));
    res.on("close", () => stop(null));
    req.on("end", () => { finished = true; ffmpeg.stdin.end(); });
    req.on("data", (chunk) => {
      if (ended) return;
      if (!ffmpeg.stdin.write(chunk)) req.pause();
    });
    ffmpeg.stdin.on("drain", () => req.resume());
    // A decoder that goes away mid-stream must not take the request down with an
    // unhandled EPIPE; `close` already classifies what happened.
    ffmpeg.stdin.on("error", () => {});

    void (async () => {
      try {
        workdir = await mkdtemp(join(tmpdir(), "stt-stream-"));
      } catch (error) {
        console.error("[stt] stream workspace failed:", error instanceof Error ? error.message : error);
        if (!res.headersSent) json(503, { error: "decoder unavailable", code: "decoder_unavailable" });
        stop(null);
        return;
      }
      if (ended) { void rm(workdir, { recursive: true, force: true }).catch(() => {}); return; }
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        connection: "close",
      });
      res.flushHeaders?.();
      timer = setInterval(() => { void tick(false); }, profile.tickMs);
      timer.unref?.();
    })();
  };
}
