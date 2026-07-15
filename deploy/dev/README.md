# BrainRouter — backend in Docker

You already run **postgres** and **bge-reranker** in Docker. These compose files add
the rest of the backend (MCP + REST + the `/v1` model gateway + the job runner on
`:3747`) plus the **Whisper STT sidecar** (`:3752`) — reusing your host postgres via
`host.docker.internal` and your real secrets from `deploy/dev/.env`.

Two shapes, pick by what you're doing:

| File | Brain runs as | Code edits reflect? | Use for |
|------|---------------|---------------------|---------|
| `docker-compose.dev.yml`  | bind-mount + `tsx watch` | **yes, live** (no rebuild) | daily development |
| `docker-compose.full.yml` | production image (baked `dist`) | no — rebuild the image | production-image parity |

`deploy/dev/.env` is built from `brainrouter/.env` with the **DB host rewritten** to
`host.docker.internal` (CORS origin left as `localhost`). It is gitignored — never commit it.

## Live-reload (recommended) — `docker-compose.dev.yml`

```bash
cd deploy/dev
docker compose -f docker-compose.dev.yml up -d          # brain (:3747) + stt (:3752)
docker compose -f docker-compose.dev.yml logs -f brain
```

- Bind-mounts the repo and runs `tsx watch`, so **an edit to `brainrouter/src/**` reloads
  the brain in seconds** — no image rebuild.
- First boot installs dependencies and builds the three brain runtime packages inside
  the container (a few minutes). Container-owned root/workspace `node_modules` and
  package `dist` volumes keep host (macOS) and container (Linux) builds separate; a host build can no
  longer delete modules underneath the running brain. The install cache automatically
  invalidates when `package-lock.json` changes.
- The brain applies DB migrations itself on boot (advisory-lock-safe — concurrent boots
  can't race the `CREATE EXTENSION` / `CREATE TABLE`).
- Edited `packages/types`, `packages/agent-protocol`, or `packages/core`? Rebuild those
  container-owned outputs once:
  `docker compose -f docker-compose.dev.yml exec brain sh -lc 'npm run build -w @kinqs/brainrouter-types && npm run build -w @kinqs/brainrouter-agent-protocol && npm run build -w @kinqs/brainrouter-core'`
  (`tsx watch` restarts the brain as the compiled outputs change).

**Just the STT sidecar** (e.g. you run `dev:http` on the host instead):

```bash
docker compose -f docker-compose.dev.yml up -d stt       # sidecar only
npm --prefix brainrouter run dev:http                     # backend on the host, :3747
```

## Production-image parity — `docker-compose.full.yml`

```bash
cd deploy/dev
docker compose -f docker-compose.full.yml up -d --build   # migrator → brain (:3747) + stt
docker compose -f docker-compose.full.yml logs -f brain
```

- The `migrator` (one-shot) applies pending migrations before the brain serves.
- The brain runs the **baked `dist`** — a code change needs a rebuild:
  `docker compose -f docker-compose.full.yml up -d --build brain`.

## Local providers from inside the container

`localhost` inside the brain container is the container, not your Mac. So a **local**
provider row (LM Studio embeddings, the `bge-reranker` on `localhost:8000`) must point at
`http://host.docker.internal:8000` (dashboard → AI Providers) for vector search + reranking
to work in the dockerized backend. Remote LLMs work as-is. Without the change the backend
still runs, degrading to FTS + RRF.

## Disk

Image builds need headroom. Reclaim safely first:
`docker builder prune -af` (build cache only — no images/containers/volumes touched).

## Verify

```bash
curl -fsS http://127.0.0.1:3752/health          # {"status":"ok","service":"stt-whisper",...}
curl -fsS http://127.0.0.1:3747/health          # {"status":"ok","transport":"http",...}
```
Then create a meeting in the dashboard (`/meetings`) and 🎙 record — the transcript comes
back from the sidecar and the notes generate in the background.
