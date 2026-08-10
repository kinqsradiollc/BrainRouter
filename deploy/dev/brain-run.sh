#!/bin/sh
# Boot script for the dev `brain` service. Shared by docker-compose.dev.yml and
# the pentest override (docker-compose.pentest.yml) so the long boot logic lives
# in ONE place. Runs from working_dir /repo. Invoked as: sh /repo/deploy/dev/brain-run.sh
set -eu

# 1) Install workspace deps once per lockfile. --ignore-scripts skips native
#    builds (node-pty is a desktop-only dep the brain never imports; the slim
#    image has no C++ toolchain). A lockfile-keyed marker makes restarts fast.
lock_hash=$(sha256sum package-lock.json | cut -c1-16)
marker=node_modules/.brain-deps-v2-$lock_hash
if [ ! -f "$marker" ]; then
  rm -f node_modules/.brain-deps-*
  npm ci --ignore-scripts
  touch "$marker"
fi

# 2) OPTIONAL (pentest override sets BRAIN_INSTALL_DOCKER_CLI=1): install the
#    Docker CLI so the brain can launch sibling pentest containers via
#    spawnSync('docker', ...). Idempotent — the command -v guard skips it on
#    restart; it only runs on container (re)creation. docker.io is the
#    least-friction single package on bookworm-slim (the daemon it pulls never
#    runs — we only use the client against the mounted host socket).
if [ "${BRAIN_INSTALL_DOCKER_CLI:-0}" = "1" ] && ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends docker.io
  rm -rf /var/lib/apt/lists/*
fi

# 2b) REQUIRED: git. The exact-revision checkout that deep review is built on
#     (`reviews/source/exactCheckout.ts`) shells out to git init/fetch/checkout,
#     and bookworm-slim ships without it. Absent, every exact checkout fails with
#     EXACT_SOURCE_UNAVAILABLE, the parser index is never built, and deep review
#     ends at DEEP_REVIEW_PREFLIGHT_SOURCE_UNAVAILABLE — while ORDINARY pr review
#     still passes, because it silently falls back to a diff-only packet. That
#     split is exactly why this was invisible for so long: the reviewer looked
#     healthy and the deep path was dead.
#     Same idempotent shape as the Docker CLI above: the guard skips it on every
#     restart, so this costs one apt-get on container (re)creation.
if ! command -v git >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends git ca-certificates
  rm -rf /var/lib/apt/lists/*
fi

# 3) Fingerprint the runtime-package sources. Their dist directories live in
#    persistent Linux volumes, while their sources come from the host bind mount;
#    existence-only checks therefore keep stale exports after a source update.
#    Rebuild when the fingerprint changes. BRAIN_REBUILD_CORE remains an
#    explicit force-rebuild escape hatch.
runtime_hash_marker=packages/core/dist/.brain-runtime-source-hash
runtime_source_hash=$(
  {
    find packages/types/src packages/agent-protocol/src packages/core/src -type f -print0
    printf '%s\0' \
      packages/types/package.json packages/types/tsconfig.json \
      packages/agent-protocol/package.json packages/agent-protocol/tsconfig.json \
      packages/core/package.json packages/core/tsconfig.json
  } | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
)
stored_runtime_hash=$(cat "$runtime_hash_marker" 2>/dev/null || true)
if [ "${BRAIN_REBUILD_CORE:-0}" = "1" ]; then
  stored_runtime_hash=
fi

# 4) Build the runtime packages on first boot, incomplete dist, or source drift.
if [ ! -f packages/types/dist/index.js ] \
  || [ ! -f packages/agent-protocol/dist/index.js ] \
  || [ ! -f packages/core/dist/review/index.js ] \
  || [ "$stored_runtime_hash" != "$runtime_source_hash" ]; then
  npm run build -w @kinqs/brainrouter-types \
    && npm run build -w @kinqs/brainrouter-agent-protocol \
    && npm run build -w @kinqs/brainrouter-core
  printf '%s\n' "$runtime_source_hash" > "$runtime_hash_marker"
fi

# 5) Hand off to tsx watch — brainrouter/src edits reflect live, no rebuild.
exec npm --prefix brainrouter run dev:http
