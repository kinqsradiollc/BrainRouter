# BrainRouter — local dev in Docker

You already run **postgres** and **bge-reranker** in Docker. This adds the missing
piece — the **Whisper STT sidecar** — and, optionally, the whole backend.

`npm run dev:http` runs the entire backend monolith on `:3747` (MCP + REST + the
`/v1` model gateway + the background job runner, with `tsx watch` live-reload). The
**only** thing it can't run is the Whisper sidecar. So there are two shapes:

## Option A — light (recommended): keep `dev:http` on the host, STT in Docker

```bash
cd deploy/dev
docker compose -f docker-compose.dev.yml up -d          # builds + starts `stt` on :3752
# in another terminal, at the repo root:
npm --prefix brainrouter run dev:http                    # backend on :3747, watches your edits
```

The host backend reaches STT at its default `BRAINROUTER_STT_URL=http://127.0.0.1:3752`.
Code edits reflect immediately (tsx watch). Nothing else changes.

## Option B — full: the backend in Docker too

```bash
cd deploy/dev
cp .env.example .env      # fill BRAINROUTER_JWT_SECRET + BRAINROUTER_SECRET_KEY (match your host values!)
docker compose -f docker-compose.dev.yml --profile brain up
```

- Bind-mounts the repo, so **a code edit reflects live** (tsx watch) — no image rebuild.
- A container-owned `node_modules` volume keeps host (macOS) and container (linux)
  native deps separate; first boot runs `npm ci && npm run build:deps` (a few min,
  cached in the volume afterwards).
- Reaches your running postgres + reranker via `host.docker.internal`. **One data
  change:** point the org's reranker provider row at `http://host.docker.internal:8000`
  (dashboard → AI Providers), since `localhost` inside the container is the container.

## Keeping Docker current with the code

- **Option A / B (tsx watch):** already live — every edit reloads, no rebuild.
- **STT sidecar** (a built image): rebuild when `deploy/stt/*` changes:
  `docker compose -f docker-compose.dev.yml build stt && docker compose -f docker-compose.dev.yml up -d stt`.
- For a **production image**, the brain Dockerfile bakes `dist` at build — rebuild
  it on release: `docker compose -f deploy/stack/docker-compose.yml build brain`.

## Disk

Image builds need headroom. Reclaim safely first:
`docker builder prune -af` (build cache only — no images/containers/volumes touched).

## Verify

```bash
curl -fsS http://127.0.0.1:3752/health          # {"status":"ok","service":"stt-whisper",...}
curl -fsS http://127.0.0.1:3747/health          # {"status":"ok","transport":"http",...}
```
Then create a meeting in the dashboard (`/meetings`) and 🎙 record — the transcript
comes back from the sidecar and the notes generate in the background.
