# syntax=docker/dockerfile:1
#
# BrainRouter brain (cognitive memory MCP server) — HTTP/Streamable transport,
# Postgres + pgvector backend. Build context is the REPO ROOT:
#
#   docker build -f deploy/brain/Dockerfile -t brainrouter-brain .
#
# or via the compose in this directory (brain + pgvector together).
# Configure at runtime with BRAINROUTER_DATABASE_URL + BRAINROUTER_SECRET_KEY /
# JWT_SECRET — see brainrouter/.env.example. AI providers are configured in the
# DB via the dashboard (ADR-012), NOT via env.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Workspace manifests first (layer-cached install). All are needed so `npm ci`
# can resolve the workspace graph from the lockfile.
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/agent-protocol/package.json packages/agent-protocol/
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/hooks/package.json packages/hooks/
COPY brainrouter/package.json brainrouter/
COPY brainrouter-cli/package.json brainrouter-cli/
COPY brainrouter-dashboard/package.json brainrouter-dashboard/
COPY brainrouter-benchmark/package.json brainrouter-benchmark/
COPY brainrouter-desktop/package.json brainrouter-desktop/

# `--ignore-scripts` skips sibling workspaces' postinstalls (e.g. the desktop's
# Electron binary download) — the brain doesn't need them.
RUN npm ci --no-audit --no-fund --ignore-scripts

# Source for the complete runtime dependency chain. Core imports the agent
# protocol at runtime, so all three workspaces must be built and copied rather
# than leaving npm workspace symlinks pointing at empty directories.
COPY packages/types ./packages/types
COPY packages/agent-protocol ./packages/agent-protocol
COPY packages/core ./packages/core
COPY brainrouter ./brainrouter
RUN npm --prefix packages/types run build \
 && npm --prefix packages/agent-protocol run build \
 && npm --prefix packages/core run build \
 && npm --prefix brainrouter run build \
 && npm prune --omit=dev --ignore-scripts \
 && test -f brainrouter/dist/migrate.js \
 && test -f brainrouter/dist/services/worker/index.js \
 && test -f brainrouter/dist/memory/store/postgres/migrations/001_init.sql

# ── runtime ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app/brainrouter

# Production deps (devDeps pruned) + the two built workspaces.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/types/package.json /app/packages/types/package.json
COPY --from=build /app/packages/types/dist /app/packages/types/dist
COPY --from=build /app/packages/agent-protocol/package.json /app/packages/agent-protocol/package.json
COPY --from=build /app/packages/agent-protocol/dist /app/packages/agent-protocol/dist
COPY --from=build /app/packages/core/package.json /app/packages/core/package.json
COPY --from=build /app/packages/core/dist /app/packages/core/dist
# Runtime JSON config read from source (NOT dist): providers/models/api-key-prefixes.
COPY --from=build /app/packages/core/config /app/packages/core/config
COPY --from=build /app/brainrouter/package.json /app/brainrouter/package.json
COPY --from=build /app/brainrouter/dist /app/brainrouter/dist

# Deterministic one-shot target used by Compose/CI before any serving process.
FROM runtime-base AS migrator
CMD ["node", "dist/migrate.js"]

# Independently deployable durable-job worker. This drains repository scans,
# vulnerability-source refresh/re-evaluation, meetings, and other async jobs.
FROM runtime-base AS worker
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD test -s /tmp/brainrouter-worker-ready || exit 1
CMD ["node", "dist/services/worker/index.js"]

# Default production target remains the HTTP/MCP service.
FROM runtime-base AS runtime
EXPOSE 3747
# BRAINROUTER_DATABASE_URL is REQUIRED (supply via env/compose). The engine
# connects + migrates lazily on first use; SIGTERM closes the pool cleanly.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3747/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http", "--port", "3747"]
