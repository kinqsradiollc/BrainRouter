# BrainRouter Whisper STT sidecar

First-party speech-to-text for Meetings (ADR-018 M1). A tiny Node wrapper around
`whisper.cpp` + `ffmpeg`. The gateway forwards audio to it at `BRAINROUTER_STT_URL`
(default `http://127.0.0.1:3752`) and it returns an OpenAI-shaped `{ text }`.

## Contract

```
POST /inference          # raw audio body (audio/webm|wav|m4a|mp3|…), returns { text }
  headers:
    x-model: <name>      # optional — whisper model name (see below)
    x-language: <xx>     # optional — force a language
GET  /health             # { status, service, model }
GET  /stream/capabilities  # { protocol, latencyModes }
POST /stream             # live transcription (ADR-035 D10) — see below
```

The gateway exposes the batch route to clients as `POST /v1/audio/transcriptions`
(on the single `:3747` door), with an optional `?model=<name>` or `x-model`
passthrough.

## Live streaming (ADR-035 D10)

`POST /stream` holds one connection for a meeting. The request body is the
container byte stream as it is recorded (the initialization segment followed by
media fragments); ending the body means end-of-audio. The response is chunked
`application/x-ndjson`, one event per line, written while audio is still
arriving:

```
{"type":"partial","utteranceId":"u3","startMs":41000,"endMs":44200,"text":"…"}
{"type":"final","utteranceId":"u3","startMs":41000,"endMs":44900,"text":"…"}
{"type":"committed","throughMs":44900}
{"type":"error","code":"undecodable_audio"}
```

Times are milliseconds from the first sample **this connection** received.
`committed` means everything through that point is represented by earlier finals
or by silence and will not be revised. `error` carries a machine code and never
prose: `undecodable_audio` means these bytes will never decode (the caller must
stop retrying them here), anything else means this service failed and the same
bytes are worth retrying. A non-2xx status — `503 decoder_unavailable`,
`429 stream_capacity` — is likewise a fact about the service, not the audio.

Internally there is no streaming decoder in whisper.cpp: one long-lived `ffmpeg`
per stream decodes the container to 16 kHz mono PCM, and a bounded trailing
window of that PCM is re-decoded with `whisper-cli` on a tick. Re-decoding is
what refines a hypothesis; committing a segment that ends more than the mode's
lookback before the live edge is what bounds the cost. See `stream.mjs` for why
that shape rather than `whisper-stream` (an SDL microphone demo).

**The gateway must be told to use it.** Set `BRAINROUTER_STT_STREAM_URL` on the
brain/gateway to this sidecar's base URL. Without it the gateway advertises
`{ "schemaVersion": 1, "segmentedUpload": true, "streaming": null }` at
`GET /v1/audio/transcriptions/capabilities`, refuses the WebSocket upgrade, and
`POST /v1/audio/transcriptions` stays the only transcription path. With it, the
gateway advertises streaming **only** while this endpoint confirms the protocol
above; if it stops confirming, the advertisement returns to segmented-only
rather than promising a live path that would fail at connect.

The bundled sidecar is batch-only. Authenticated clients may query
`GET /v1/audio/transcriptions/capabilities`; this deployment reports
`{ "schemaVersion": 1, "segmentedUpload": true, "streaming": null }`.
`POST /v1/audio/transcriptions` remains the active transcription path. The
gateway's WebSocket route is reserved for an injected adapter satisfying the
complete D10 contract and returns 503 without one.

## Using a HuggingFace Whisper model

The sidecar loads `whisper.cpp` **ggml** models — all of which live on HuggingFace.

- **One model (build time):** override the baked model:
  ```
  docker build -t brainrouter-stt \
    --build-arg WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
    deploy/stt
  ```
  Common ggml choices: `ggml-base.en.bin`, `ggml-small.bin`, `ggml-medium.bin`,
  `ggml-large-v3.bin`, `ggml-distil-large-v3.bin`.

- **Several models (runtime, selectable per request):** mount a volume of
  `ggml-<name>.bin` files at `/models` and call with `x-model: <name>`:
  ```yaml
  stt:
    volumes: [ "./whisper-models:/models" ]   # ggml-base.en.bin, ggml-small.bin, …
  ```
  ```
  POST /v1/audio/transcriptions?model=small
  ```
  Unknown/unsafe names fall back to `WHISPER_MODEL` — a bad model name never fails
  the request.

## Env

| Var | Default | Meaning |
|---|---|---|
| `STT_PORT` | `3752` | listen port |
| `WHISPER_MODEL` | `/models/ggml-base.en.bin` | default model file |
| `WHISPER_MODELS_DIR` | `/models` | where `x-model` names resolve |
| `WHISPER_THREADS` | cores−1 | decode threads |
| `STT_MAX_BYTES` | 80 MB | per-request audio cap (`POST /inference`) |
| `STT_STREAM_MODES` | all three | which latency modes `/stream` offers, from `low-latency,balanced,high-accuracy` |
| `STT_STREAM_MIN_TICK_MS` | 0 | floor on how often a window is re-decoded — raise it on a small box |
| `STT_STREAM_MAX_SESSIONS` | 2 | concurrent live streams (each one holds a decoder) |
| `STT_STREAM_MAX_BYTES` | 512 MB | decoded PCM cap per live stream |
| `STT_STREAM_MAX_MS` | 6 h | wall-clock audio cap per live stream |

## transformers / safetensors checkpoints

`whisper.cpp` cannot load transformers checkpoints (e.g. `openai/whisper-large-v3`
in safetensors, or transformers-only fine-tunes). For those, run a **faster-whisper**
(CTranslate2) sidecar that exposes the same `POST /inference` → `{ text }` contract
and point `BRAINROUTER_STT_URL` at it — no gateway change. Convert the ggml first
where possible; otherwise faster-whisper is the drop-in for GPU accuracy.
