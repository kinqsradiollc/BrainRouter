# BrainRouter Whisper STT sidecar — first-party speech-to-text for Meetings.
# Builds whisper.cpp from a pinned release, bundles ffmpeg + a tiny Node wrapper
# exposing POST /inference (raw audio -> { text }). Internal-network only; never
# published to the host, so the single-:3747 door invariant holds.

# ── build whisper.cpp ────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG WHISPER_CPP_REF=v1.7.4
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" https://github.com/ggerganov/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build /src/build --config Release -j "$(nproc)" \
 && (cp /src/build/bin/whisper-cli /usr/local/bin/whisper-cli 2>/dev/null \
     || cp /src/build/bin/main /usr/local/bin/whisper-cli)

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
# Bake a default English model. Override WHISPER_MODEL_URL to pick another size
# (e.g. ggml-small.bin / ggml-medium.bin) or mount a model volume + set WHISPER_MODEL.
ARG WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
RUN mkdir -p /models && curl -fsSL "${WHISPER_MODEL_URL}" -o /models/ggml-base.en.bin
COPY server.mjs /app/server.mjs
ENV STT_PORT=3752 \
    WHISPER_MODEL=/models/ggml-base.en.bin \
    WHISPER_BIN=whisper-cli
EXPOSE 3752
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3752/health || exit 1
CMD ["node", "/app/server.mjs"]
