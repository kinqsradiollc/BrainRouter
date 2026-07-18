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

# 3) OPTIONAL (BRAIN_REBUILD_CORE=1): the step-4 gate is existence-only and the
#    dist volume persists across recreation, so a stale compiled packages/core
#    keeps loading after you edit packages/core/src. Delete the marker file the
#    gate keys on to force a fresh core build. Set this on the FIRST boot after
#    editing the pentest runtime (packages/core/src/review/*).
if [ "${BRAIN_REBUILD_CORE:-0}" = "1" ]; then
  rm -f packages/core/dist/review/index.js
fi

# 4) Build the runtime packages the brain imports, on first boot / missing marker.
if [ ! -f packages/types/dist/index.js ] \
  || [ ! -f packages/agent-protocol/dist/index.js ] \
  || [ ! -f packages/core/dist/review/index.js ]; then
  npm run build -w @kinqs/brainrouter-types \
    && npm run build -w @kinqs/brainrouter-agent-protocol \
    && npm run build -w @kinqs/brainrouter-core
fi

# 5) Hand off to tsx watch — brainrouter/src edits reflect live, no rebuild.
exec npm --prefix brainrouter run dev:http
