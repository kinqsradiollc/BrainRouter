# Deploying the dashboard to Cloudflare Workers

The dashboard is a fully client-rendered Next.js app — there are no API routes,
server components, or server actions; all data comes from the BrainRouter HTTP
API through the SDK. That means it **exports to static HTML** and is served by a
Cloudflare Worker using [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
— no SSR runtime, no cold starts, global edge caching.

## Cloudflare project settings

The dashboard is part of an npm **workspace**; its shared deps
(`@kinqs/brainrouter-types` / `-sdk` / `-hooks`) live in `packages/*`. You can
build straight from the dashboard subdirectory — **Recommended** — because
`build:cf` builds those workspace packages before the dashboard:

| Setting | Value |
| --- | --- |
| **Root directory** | `brainrouter-dashboard` |
| **Build command** | `npm run build:cf` |
| **Deploy command** *(Workers Builds)* | `npx wrangler deploy` |
| **Build output directory** *(Pages)* | `out` |
| **Environment variables** | `NEXT_PUBLIC_API_URL=https://your-api` (+ `NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION=true` for the marketing-only preview) |

> **Use `build:cf`, never the default `npm run build`** — two reasons:
> - Plain `next build` produces a `.next` **server** build, not the static export
>   the Worker serves. `build:cf` sets `CLOUDFLARE_BUILD=1` → `output: "export"` →
>   `./out`.
> - It also **never builds the workspace packages** — the subtle one. Cloudflare
>   runs `npm ci` from the **repo root** (where the lockfile lives), so npm
>   **symlinks the local `packages/*` over the npm copies**, and those have no
>   `dist/` (gitignored) until built. The dashboard then resolves an empty
>   `@kinqs/brainrouter-hooks` and fails with
>   *`Can't resolve '@kinqs/brainrouter-hooks'`*. `build:cf` runs
>   `npm --prefix .. run build:packages` (`types → sdk → hooks`) first, so the
>   symlinked packages have a `dist/` by the time `next build` resolves them.
> - `wrangler deploy` must run **inside `brainrouter-dashboard/`** (where
>   `wrangler.jsonc` + `out/` are). Running it at the repo root fails with
>   *"detection logic has been run in the root of a workspace…"*. Keeping **Root
>   directory = `brainrouter-dashboard`** makes both the build and `npx wrangler
>   deploy` run there automatically.

### Alternative: build from the repo root

Equivalent — if you prefer the repo root as the build directory (both paths build
the workspace packages from source, this one just centralizes it):

| Setting | Value |
| --- | --- |
| **Root directory** | `/` (repo root) |
| **Build command** | `npm run cf:build` (builds `types → sdk → hooks` then the dashboard static export) |
| **Deploy command** *(Workers Builds)* | `npm run cf:deploy` (= `cd brainrouter-dashboard && npx wrangler deploy`) |
| **Build output directory** *(Pages)* | `brainrouter-dashboard/out` |

(`cf:deploy` exists so the deploy step `cd`s into the project — running
`wrangler` from the workspace root errors.)

## How it's wired

- **`next.config.ts`** — `output: "export"` is enabled only when
  `CLOUDFLARE_BUILD=1`, so the normal `next build` / `next start` (server build)
  is untouched for local dev and other targets. The Cloudflare build writes
  static HTML + assets to **`./out`**.
- **`wrangler.jsonc`** — an assets-only Worker (no `main` entrypoint) that serves
  `./out`. `/overview` resolves to `/overview.html`; unknown paths get
  `404.html`.

## Build-time environment (important)

A static export **inlines `NEXT_PUBLIC_*` at build time** — there is no server to
read env vars at runtime. Set them when you build:

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | BrainRouter HTTP API the dashboard calls (e.g. `https://api.example.com`). |
| `NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION` | `true` for a marketing-only preview (no backend, only `/` + `/about`); unset/`false` for the full app. |

## Commands

```bash
# Build the static bundle into ./out
NEXT_PUBLIC_API_URL=https://api.example.com npm run build:cf

# Preview the Worker locally (build + wrangler dev)
npm run cf:preview

# Deploy (build + wrangler deploy) — needs `wrangler login` once
NEXT_PUBLIC_API_URL=https://api.example.com npm run cf:deploy
```

First-time setup: `npx wrangler login`, then set `name`/route/custom domain in
`wrangler.jsonc` (and a `[env.production]` block if you want staging vs prod).

## Notes

- **Why not OpenNext / SSR Workers?** Nothing in the app needs a server. If a
  future feature adds API routes or server components, switch to
  [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) — drop
  `output: "export"`, add `main`, and keep the same Worker.
- **CORS**: the BrainRouter server must allow the dashboard's origin
  (`BRAINROUTER_CORS_ORIGIN` on the server side).
