# syntax=docker/dockerfile:1
#
# BrainRouter brain (cognitive memory MCP server) — HTTP/Streamable transport,
# Postgres + pgvector backend. Build context is the REPO ROOT:
#
#   docker build -f deploy/brain/Dockerfile -t brainrouter-brain .
#
# or via the compose in this directory (brain + pgvector together).
# Configure at runtime with BRAINROUTER_DATABASE_URL (+ optional LLM keys) — see
# brainrouter/.env.example for the full set.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Workspace manifests first (layer-cached install). All are needed so `npm ci`
# can resolve the workspace graph from the lockfile.
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY brainrouter/package.json brainrouter/
COPY brainrouter-cli/package.json brainrouter-cli/
COPY brainrouter-dashboard/package.json brainrouter-dashboard/
COPY brainrouter-benchmark/package.json brainrouter-benchmark/
COPY brainrouter-desktop/package.json brainrouter-desktop/

# `--ignore-scripts` skips sibling workspaces' postinstalls (e.g. the desktop's
# Electron binary download) — the brain doesn't need them.
RUN npm ci --no-audit --no-fund --ignore-scripts

# Source for only what the brain needs: the shared types contract, then the brain.
COPY packages/types ./packages/types
COPY brainrouter ./brainrouter
RUN npm --prefix packages/types run build \
 && npm --prefix brainrouter run build \
 && npm prune --omit=dev --ignore-scripts

# ── runtime ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/brainrouter

# Production deps (devDeps pruned) + the two built workspaces.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/types/package.json /app/packages/types/package.json
COPY --from=build /app/packages/types/dist /app/packages/types/dist
COPY --from=build /app/brainrouter/package.json /app/brainrouter/package.json
COPY --from=build /app/brainrouter/dist /app/brainrouter/dist

EXPOSE 3747
# BRAINROUTER_DATABASE_URL is REQUIRED (supply via env/compose). The engine
# connects + migrates lazily on first use; SIGTERM closes the pool cleanly.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3747/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http", "--port", "3747"]
