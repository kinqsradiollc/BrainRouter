/**
 * BrainRouter Whisper STT sidecar — first-party speech-to-text (ADR-018 M1).
 *
 * A tiny dependency-free Node service that fronts whisper.cpp. It accepts the raw
 * audio bytes the gateway forwards (POST /inference, any container/codec via
 * ffmpeg), transcodes to the 16 kHz mono PCM WAV whisper.cpp expects, runs the
 * whisper.cpp CLI, and returns `{ text }`. Swappable behind the same HTTP contract
 * (BRAINROUTER_STT_URL on the gateway) — a faster-whisper sidecar could replace it
 * with no gateway change. Runs on the internal network only; never host-exposed.
 */
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number.parseInt(process.env.STT_PORT ?? "3752", 10);
const MODEL = process.env.WHISPER_MODEL ?? "/models/ggml-base.en.bin";
const WHISPER_BIN = process.env.WHISPER_BIN ?? "whisper-cli";
const THREADS = process.env.WHISPER_THREADS ?? String(Math.max(1, (os.cpus?.().length ?? 4) - 1));
const MAX_BYTES = Number.parseInt(process.env.STT_MAX_BYTES ?? String(80 * 1024 * 1024), 10);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 600)}`))));
  });
}

async function transcribe(input) {
  const dir = await mkdtemp(join(tmpdir(), "stt-"));
  const inPath = join(dir, "in");
  const wavPath = join(dir, "audio.wav");
  try {
    await writeFile(inPath, input);
    // Any input (webm/opus, m4a, mp3, wav, …) → 16 kHz mono PCM WAV.
    await run("ffmpeg", ["-nostdin", "-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath]);
    // whisper.cpp writes "<wav>.txt" with -otxt; -nt strips timestamps.
    await run(WHISPER_BIN, ["-m", MODEL, "-f", wavPath, "-otxt", "-nt", "-t", THREADS]);
    const text = await readFile(`${wavPath}.txt`, "utf8").catch(() => "");
    return text.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") { json(200, { status: "ok", service: "stt-whisper", model: MODEL }); return; }
  if (req.method === "POST" && (req.url === "/inference" || req.url?.startsWith("/inference?"))) {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) { aborted = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (aborted) return;
      const audio = Buffer.concat(chunks);
      if (audio.length === 0) { json(400, { error: "no audio" }); return; }
      try {
        json(200, { text: await transcribe(audio) });
      } catch (error) {
        json(500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }
  json(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[stt] whisper sidecar listening on :${PORT} (model ${MODEL}, ${THREADS} threads)`));
