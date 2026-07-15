# BrainRouter Whisper STT sidecar

First-party speech-to-text for Meetings (ADR-018 M1). A tiny Node wrapper around
`whisper.cpp` + `ffmpeg`. The gateway forwards audio to it at `BRAINROUTER_STT_URL`
(default `http://127.0.0.1:3752`) and it returns an OpenAI-shaped `{ text }`.

## Contract

```
POST /inference        # raw audio body (audio/webm|wav|m4a|mp3|…), returns { text }
  headers:
    x-model: <name>    # optional — whisper model name (see below)
    x-language: <xx>   # optional — force a language
GET  /health           # { status, service, model }
```

The gateway exposes this to clients as `POST /v1/audio/transcriptions` (on the
single `:3747` door), with an optional `?model=<name>` or `x-model` passthrough.

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
| `STT_MAX_BYTES` | 80 MB | per-request audio cap |

## transformers / safetensors checkpoints

`whisper.cpp` cannot load transformers checkpoints (e.g. `openai/whisper-large-v3`
in safetensors, or transformers-only fine-tunes). For those, run a **faster-whisper**
(CTranslate2) sidecar that exposes the same `POST /inference` → `{ text }` contract
and point `BRAINROUTER_STT_URL` at it — no gateway change. Convert the ggml first
where possible; otherwise faster-whisper is the drop-in for GPU accuracy.
