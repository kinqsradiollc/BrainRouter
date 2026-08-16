/**
 * The audio plane's failure contract (ADR-035 D5/D7).
 *
 * Almost every test here is about a STATUS rather than a body, because the
 * status is what `packages/core`'s transcription queue reads to decide whether a
 * failed segment costs a retry. The set below is that queue's rule, restated
 * here on purpose: this suite must fail if the route ever answers a permanent,
 * this-audio-is-not-decodable failure with a status the queue would refund, and
 * it must fail WITHOUT depending on core being rebuilt first — a stale
 * cross-workspace dist is not a reason for the gateway's own contract test to go
 * quiet.
 *
 * The one-line summary of the defect this file exists to prevent: when every
 * sidecar outcome was a 502, an undecodable segment was retried forever, never
 * became a stated gap, and re-uploaded itself to our own sidecar every minute.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

import { registerGatewayAudioPlane } from "./audioRoutes.js";

/** `classifyTranscriptionFailure`'s refund set — a status in here costs the segment no attempt. */
const REFUNDED_STATUSES = new Set([408, 429, 502, 503, 504]);

type SidecarHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** Answer `/inference` with a fixed status/body, after draining the audio. */
function answers(status: number, body: string, headers: Record<string, string> = {}): SidecarHandler {
  return (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
    });
  };
}

/** A sidecar that accepts the upload and then simply never answers. */
const silence: SidecarHandler = (req) => { req.resume(); };

interface Harness {
  post(body: string | undefined, path?: string): Promise<{ response: Response; body: any }>;
}

/**
 * A fake sidecar plus an app with only the audio plane on it. The route reads no
 * auth context, so mounting it bare keeps each case about the STT contract and
 * nothing else.
 */
async function withHarness(sidecar: SidecarHandler | null, run: (harness: Harness) => Promise<void>): Promise<void> {
  const servers: http.Server[] = [];
  const stop = async (server: http.Server): Promise<void> => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    let sttPort: number;
    if (sidecar) {
      const stt = http.createServer(sidecar);
      stt.listen(0);
      await new Promise<void>((resolve) => stt.once("listening", resolve));
      servers.push(stt);
      sttPort = (stt.address() as AddressInfo).port;
    } else {
      // A port with nothing on it: a closed listener's port is the most reliable
      // way to produce a real ECONNREFUSED rather than a hung connect.
      const probe = http.createServer(() => {});
      probe.listen(0);
      await new Promise<void>((resolve) => probe.once("listening", resolve));
      sttPort = (probe.address() as AddressInfo).port;
      await stop(probe);
    }
    process.env.BRAINROUTER_STT_URL = `http://127.0.0.1:${sttPort}`;

    const app = express();
    registerGatewayAudioPlane(app);
    const gateway = app.listen(0);
    await new Promise<void>((resolve) => gateway.once("listening", resolve));
    servers.push(gateway);
    const { port } = gateway.address() as AddressInfo;

    await run({
      async post(body, path = "/v1/audio/transcriptions") {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "audio/webm" },
          ...(body === undefined ? {} : { body }),
        });
        const text = await response.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        return { response, body: parsed };
      },
    });
  } finally {
    for (const server of servers.reverse()) await stop(server);
  }
}

describe("gateway audio plane", () => {
  const env = { ...process.env };

  beforeEach(() => {
    // The route's own logging is deliberate (an operator has to be able to see a
    // misconfigured sidecar); it is just noise in a test run.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.BRAINROUTER_STT_URL = env.BRAINROUTER_STT_URL;
    process.env.BRAINROUTER_STT_MAX_BODY = env.BRAINROUTER_STT_MAX_BODY;
    process.env.BRAINROUTER_STT_TIMEOUT_MS = env.BRAINROUTER_STT_TIMEOUT_MS;
    for (const key of ["BRAINROUTER_STT_URL", "BRAINROUTER_STT_MAX_BODY", "BRAINROUTER_STT_TIMEOUT_MS"]) {
      if (env[key] === undefined) delete process.env[key];
    }
  });

  it("returns the sidecar's text on success", async () => {
    await withHarness(answers(200, JSON.stringify({ text: "  hello there  " })), async ({ post }) => {
      const { response, body } = await post("AUDIOBYTES");
      expect(response.status).toBe(200);
      expect(body.text).toBe("hello there");
    });
  });

  it("rejects an empty audio body without calling the sidecar", async () => {
    await withHarness(answers(200, JSON.stringify({ text: "unreachable" })), async ({ post }) => {
      const { response, body } = await post(undefined);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe("missing_audio");
    });
  });

  describe("a failure of the INPUT is permanent and client-class", () => {
    it("answers a sidecar 4xx with 422 rather than 502", async () => {
      await withHarness(answers(400, JSON.stringify({ error: "no audio" })), async ({ post }) => {
        const { response, body } = await post("NOTAUDIO");
        expect(response.status).toBe(422);
        expect(body.error.code).toBe("stt_undecodable_audio");
        expect(REFUNDED_STATUSES.has(response.status)).toBe(false);
      });
    });

    it("answers an unsupported container with 422", async () => {
      await withHarness(answers(415, JSON.stringify({ error: "unsupported" })), async ({ post }) => {
        const { response, body } = await post("NOTAUDIO");
        expect(response.status).toBe(422);
        expect(body.error.code).toBe("stt_undecodable_audio");
      });
    });

    it("reads ffmpeg's rejection inside a sidecar 500 as undecodable audio", async () => {
      // The defect, exactly: the first-party sidecar reports a transcode failure
      // as a 500, so this case used to be indistinguishable from an outage and
      // retried forever.
      const detail = JSON.stringify({ error: "ffmpeg exited 1: /tmp/stt-a1b2/in: Invalid data found when processing input" });
      await withHarness(answers(500, detail), async ({ post }) => {
        const { response, body } = await post("NOTAUDIO");
        expect(response.status).toBe(422);
        expect(body.error.code).toBe("stt_undecodable_audio");
      });
    });

    it("believes a sidecar that names the failure itself", async () => {
      await withHarness(answers(500, JSON.stringify({ code: "unsupported_audio", error: "cannot decode" })), async ({ post }) => {
        const { response, body } = await post("NOTAUDIO");
        expect(response.status).toBe(422);
        expect(body.error.code).toBe("stt_undecodable_audio");
      });
    });

    it("answers a body over the configured limit with 413 in the gateway's own envelope", async () => {
      process.env.BRAINROUTER_STT_MAX_BODY = "1kb";
      await withHarness(answers(200, JSON.stringify({ text: "unreachable" })), async ({ post }) => {
        const { response, body } = await post("x".repeat(4096));
        expect(response.status).toBe(413);
        expect(body.error.code).toBe("request_too_large");
        expect(body.error.type).toBe("invalid_request_error");
        expect(REFUNDED_STATUSES.has(response.status)).toBe(false);
      });
    });
  });

  describe("a failure of the DEPENDENCY stays refundable", () => {
    it("answers a sidecar 5xx with 502", async () => {
      await withHarness(answers(503, JSON.stringify({ error: "restarting" })), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(502);
        expect(body.error.code).toBe("stt_unavailable");
        expect(REFUNDED_STATUSES.has(response.status)).toBe(true);
      });
    });

    it("does not blame the audio when the sidecar's own tooling failed", async () => {
      await withHarness(answers(500, JSON.stringify({ error: "whisper-cli exited 3: failed to load model" })), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(502);
        expect(body.error.code).toBe("stt_unavailable");
      });
    });

    it("does not blame the audio when ffmpeg failed for an environment reason", async () => {
      const detail = JSON.stringify({ error: "ffmpeg exited 1: /tmp/stt-a1b2/audio.wav: No space left on device" });
      await withHarness(answers(500, detail), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(502);
        expect(body.error.code).toBe("stt_unavailable");
      });
    });

    it("does not blame the audio for a sidecar that named a failure of its own", async () => {
      await withHarness(answers(500, JSON.stringify({ code: "model_missing", error: "ffmpeg exited 1: nope" })), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(502);
        expect(body.error.code).toBe("stt_unavailable");
      });
    });

    it("treats a wrong STT URL as an outage, not a verdict on the audio", async () => {
      // A 404 means we are pointed at something that is not an STT service. An
      // operator fixes that; the user's segments then drain from disk. Charging
      // their retry budget for our misconfiguration would leave permanent gaps.
      await withHarness(answers(404, JSON.stringify({ error: "not found" })), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(502);
        expect(body.error.code).toBe("stt_unavailable");
      });
    });

    it("passes a rate limit through, with the sidecar's own backoff", async () => {
      await withHarness(answers(429, JSON.stringify({ error: "busy" }), { "retry-after": "7" }), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(429);
        expect(body.error.code).toBe("stt_rate_limited");
        expect(response.headers.get("retry-after")).toBe("7");
        expect(REFUNDED_STATUSES.has(response.status)).toBe(true);
      });
    });

    it("answers an unreachable sidecar with 502", async () => {
      await withHarness(null, async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(502);
        expect(body.error.code).toBe("stt_unavailable");
      });
    });

    it("answers a sidecar that never replies with 504 once the bound elapses", async () => {
      process.env.BRAINROUTER_STT_TIMEOUT_MS = "150";
      await withHarness(silence, async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(504);
        expect(body.error.code).toBe("stt_timeout");
        expect(REFUNDED_STATUSES.has(response.status)).toBe(true);
      });
    });

    it("ignores a nonsensical timeout rather than aborting every request", async () => {
      // A `0` here would abort instantly and read to every client as a dead
      // sidecar — the failure mode is silent, so the fallback is not optional.
      process.env.BRAINROUTER_STT_TIMEOUT_MS = "0";
      await withHarness(answers(200, JSON.stringify({ text: "still works" })), async ({ post }) => {
        const { response, body } = await post("AUDIOBYTES");
        expect(response.status).toBe(200);
        expect(body.text).toBe("still works");
      });
    });
  });

  it("never leaks the sidecar's internals into the response", async () => {
    const detail = JSON.stringify({ error: "ffmpeg exited 1: /srv/models/ggml-base.en.bin at 127.0.0.1:3752 — Invalid data" });
    await withHarness(answers(500, detail), async ({ post }) => {
      const { body } = await post("NOTAUDIO");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/ffmpeg|whisper|ggml|3752|\/srv\/|\/tmp\//i);
      expect(body.error.message).toMatch(/audio could not be decoded/i);
    });
  });
});
