# BrainRouter Whisper STT sidecar — first-party speech-to-text for Meetings.
# Builds whisper.cpp from a pinned release, bundles ffmpeg + a tiny Node wrapper
# exposing POST /inference (raw audio -> { text }) and POST /stream (ADR-035 D10
# live transcription). In the shipped stack it is `expose:`d to the compose
# network only, so clients still have the single :3747 door; the dev composes
# publish it on 127.0.0.1:3752 so it can be probed by hand, which is loopback
# and not the LAN, but is not "never".

# ── build whisper.cpp ────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG WHISPER_CPP_REF=v1.7.4
# GGML_NATIVE=OFF disables the -mcpu=native auto-detection (which emits a flag
# value the arm64 build gcc rejects). BUILD_SHARED_LIBS=OFF statically links the
# CLI so the runtime image needs no libwhisper.so/libggml*.so — a portable,
# self-contained binary is exactly what an image wants.
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" https://github.com/ggerganov/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
 && cmake --build /src/build --config Release -j "$(nproc)" \
 && (cp /src/build/bin/whisper-cli /usr/local/bin/whisper-cli 2>/dev/null \
     || cp /src/build/bin/main /usr/local/bin/whisper-cli)

# ── runtime ──────────────────────────────────────────────────────────────────
# Node 22 to match the brain image (the wrapper only uses stable stdlib APIs).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
# Bake a default English model. Override WHISPER_MODEL_URL to pick another size
# (e.g. ggml-small.bin / ggml-medium.bin) or mount a model volume + set WHISPER_MODEL.
ARG WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
RUN mkdir -p /models && curl -fsSL "${WHISPER_MODEL_URL}" -o /models/ggml-base.en.bin
COPY server.mjs stream.mjs /app/
ENV STT_PORT=3752 \
    WHISPER_MODEL=/models/ggml-base.en.bin \
    WHISPER_BIN=whisper-cli
EXPOSE 3752
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3752/health || exit 1
CMD ["node", "/app/server.mjs"]
