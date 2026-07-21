# 06 — Desktop & Dashboard

`brainrouter-desktop/` (Electron: `electron/` host + `src/` vite renderer) and
`brainrouter-dashboard/` (Next.js app-router SPA against a user-local brain
server).

---

## Desktop: host vs renderer boundary

### 1. ⛔ Host imports curated core entrypoints; renderer deep-imports browser-safe `dist` modules

Code under `electron/**` runs in Node and MUST import core via curated subsystem
entrypoints (`@kinqs/brainrouter-core/agent`, `/config`, …). Code under `src/**`
(the vite renderer) is **exempt** and intentionally deep-imports specific
browser-safe compiled modules (e.g.
`@kinqs/brainrouter-core/dist/write/writeDiff.js`) because a curated entrypoint
re-exports its FULL surface including `node:fs`/`node:crypto` modules that break
`vite build`. **Never "fix" a renderer deep import to the curated entrypoint.**

- **Why:** TypeScript won't catch it — it surfaces as a broken production build.
- **Evidence:** `eslint.config.mjs`, `brainrouter-desktop/electron/host.ts:31`,
  `brainrouter-desktop/src/panels/planning/WorkflowsPanel.tsx:23`

### 2. ⛔ `preload.cts` is the renderer's only capability surface

All renderer↔host communication goes through `window.brainrouter`, exposed in
`electron/preload.cts` via `contextBridge`: the agent protocol on one
`send`/`onEvent` channel pair, plus typed `ipcRenderer.invoke` methods for
main-process work (workspace dialogs, OAuth, zoom). `BrowserWindow` runs with
`contextIsolation:true`, `nodeIntegration:false`; `will-navigate` is gated by the
pure `isAllowedNavigation` policy (`file://` + dev origin only); `window.open` is
deny-all. To add a capability, add a typed method to `preload.cts` + a handler in
main/host — **never widen `webPreferences`.**

- **Why:** a compromised renderer must not navigate away or reach Node;
  security-sensitive brokering (GitHub OAuth) stays in main so tokens never reach
  the renderer.
- **Evidence:** `brainrouter-desktop/electron/preload.cts:1`, `brainrouter-desktop/electron/windowSecurity.ts:1`

### 3. Data fetching = named queries over the agent-command channel, not new IPC channels

Request/response data for panels/dialogs is a named handler in the host's query
router (`buildQueries` in `electron/host/queries.ts`), consumed in the renderer via
`bridgeQuery`/`hostQuery` (send `{kind:'query', id, name, args}`, resolve on the
matching `query-result` event with a timeout). Renderer listeners must accept BOTH
event shapes: workspace-wrapped `{workspaceRoot, event}` from the real host **and**
bare events from the dev bridge.

- **Why:** one transport keeps the preload surface small; handling only one
  envelope shape silently breaks either the packaged app or browser dev.
- **Evidence:** `brainrouter-desktop/src/lib/bridgeQuery.ts:19`, `brainrouter-desktop/electron/host/queries.ts:1`

### 4. Every renderer surface must render populated in a plain browser via the devBridge mock

`src/App.tsx` calls `installDevBridge()`, which installs a canned
`window.brainrouter` whenever the real preload bridge is absent (vite dev in a
browser). When you add a host query/command/event, add a matching mock in
`src/devBridge/queries.ts` (handler map) **and** `src/devBridge/state.ts` (stateful
mock data that actually mutates), so the UI is exercisable without Electron.
Dev-only presets go through query-string flags in `src/lib/devFlags.ts` (no-op in
production).

- **Why:** UI work happens screenshot-driven in the browser preview; an unmocked
  query renders an empty/broken surface and blocks review.
- **Evidence:** `brainrouter-desktop/src/devBridge.ts:1`, `brainrouter-desktop/src/App.tsx:44`

### 5. Respect workspace identity on the event stream: drop stale, trust `session-changed`

Main tags every agent-event with its owning `workspaceRoot`; renderer code
consuming events must apply the pure helpers in `src/lib/workspace/workspaceEvents.ts`
— drop events whose `workspaceRoot` differs from the active workspace
(`isStaleWorkspaceEvent`), treat `session-changed` as the authoritative,
never-stale switch signal, and let untagged events pass. Query ids are
workspace-tagged too (`tagQueryId`).

- **Why:** without the drop logic, a background turn in workspace A paints into
  workspace B's chat; filtering `session-changed` itself would wedge the active
  workspace forever.
- **Evidence:** `brainrouter-desktop/src/lib/workspace/workspaceEvents.ts:1`, `brainrouter-desktop/src/App.tsx:16`

---

## Desktop: secrets, settings, models

### 6. ⛔ Secrets are write-only: `config.json` or `safeStorage`, never `.env`, never echoed to the renderer

Integration secrets are entered in Settings and stored either in `config.json`
`cli.*` (e.g. `cli.track.githubToken`) or the host-only safeStorage-encrypted
`secretStore` — never `.env`. **No host endpoint ever RETURNS a secret value:** the
renderer only learns presence (`hasToken`, `tokenSource`); config snapshots pass
through `scrubCliSecrets` (masks API keys, deletes tokens) before crossing the
bridge; token inputs are `type=password`, start empty, show a `•••• (set)`
placeholder, and clear after save.

- **Why:** the cliKnobs snapshot is displayed verbatim in Settings → Advanced; an
  unscrubbed field or read-back endpoint leaks the token to the UI and logs.
- **Evidence:** `brainrouter-desktop/electron/host/helpers.ts:30`, `brainrouter-desktop/electron/secretStore.ts:1`

### 7. Settings sections are per-folder modules built from shared `Row`/`Toggle`/`KnobValue` controls

Each Settings area lives in `src/settings/<section>/` with an `index.ts` barrel
(connectors, marketplace, usage, models, cli, permissions, github) and builds its
UI exclusively from the shared controls in `src/settings/shared/controls.tsx`
(`Row`, `Toggle`, `KnobValue`, `ChoiceControl`). Follow this folder + shared-control
pattern rather than inventing new row markup.

- **Evidence:** `brainrouter-desktop/src/settings/shared/controls.tsx:10`

### 8. ⛔ Model lists come from the endpoint's `GET /models` — never hardcoded, proxied in browser dev

Any model picker probes the configured provider endpoint's `/models`: host-side
via `fetchEndpointModels` (`electron/host/helpers.ts`), and in browser dev via the
vite `modelProbeProxy` middleware (POST `/__brp/models`), because LLM gateways send
no CORS headers so the renderer can't fetch them directly. Never ship a
hand-written model list or hardcoded model-name placeholder.

- **Evidence:** `brainrouter-desktop/vite.config.ts:1`, `brainrouter-desktop/electron/host/helpers.ts:1`

---

## Desktop: theming & styling gotchas

### 9. Theme = CSS variables keyed by `[data-theme]`; interaction tints only from the `--ov-*` scale

All desktop colors come from CSS custom properties defined once in `src/theme.css`
under `:root, [data-theme="dark"]` (Graphite Mono) and `[data-theme="hc"]`
overrides — components never hardcode colors. Hover/active/divider tints use the
tokenized white-overlay scale (`--ov-025` … `--ov-26`), not ad-hoc rgba literals.
Radii (`--r-sm/md/lg`) and fonts (`--font`/`--mono`) are tokens too.
**User-facing theme names must not reference "Claude".**

- **Why:** the `hc` theme restyles the app by swapping variables only; a literal
  color or a "Claude"-named theme breaks theme switching / branding rules.
- **Evidence:** `brainrouter-desktop/src/theme.css:1,26`

### 10. Button reset clears background only — set your own border; never theme a native `<select>`

`theme.css` globally resets `button { background: transparent; font-family: var(--font); }`
but does NOT clear the UA border — any new styled button must set `border: 0` (or
an explicit border) itself. For dropdowns inside themed surfaces, do **not** use a
native `<select>` (the OS-drawn option list can't be themed and clips inside
scrolling containers) — use the `TrackDropdown` pattern: a trigger button plus a
menu portaled to `<body>` with fixed positioning and flip-up logic.

- **Evidence:** `brainrouter-desktop/src/theme.css:63,152`, `brainrouter-desktop/src/track/Dropdown.tsx:1`

### 11. Frameless-window drag regions must be explicitly re-disabled on interactive children

The rail and chat header are `-webkit-app-region: drag` (frameless hiddenInset
window). Every interactive element inside a drag region needs
`-webkit-app-region: no-drag` — `theme.css` maintains an explicit selector list;
add new popovers/controls there (or set no-drag locally). macOS traffic lights
overlay the top-left: use the `[data-os="mac"]` selectors to reserve padding
(72–80px) wherever content reaches the window's top-left edge.

- **Why:** a forgotten no-drag makes a button drag the window instead of clicking;
  missing mac padding hides controls behind the traffic lights.
- **Evidence:** `brainrouter-desktop/src/theme.css:67,102,109,126`

### 12. Module headers are contracts; relative imports carry `.js` even in `.tsx`

Every non-trivial module opens with a JSDoc header carrying its task tag (`DESK-1`,
`SEC`, `§goal-autonomy`) and states the contract + WHY, often with invariants in
CAPITALS — these headers are the primary architecture docs for this workspace.
Both `electron/**` and `src/**` are ESM; every relative import ends in `.js` even
from `.tsx` (preload `.cts` is the CommonJS exception). God files split into
per-concern sibling directories with a thin, behavior-identical entrypoint (see
[`03`](03-refactoring-and-god-files.md)).

- **Evidence:** `brainrouter-desktop/electron/host.ts:1`, `brainrouter-desktop/src/track/Dropdown.tsx:12`

### 13. Desktop account transitions persist before serialized live MCP cleanup

Desktop sign-in and sign-out use strict config persistence before changing live
MCP state or reporting success. Sign-in targets the explicitly selected
BrainRouter profile and records it as the active brain only after the durable
commit. Sign-out removes credentials durably, then performs serialized live
cleanup with reconnects paused; a cleanup failure returns a committed warning and
must not resurrect the removed profile or credential.

- **Why:** disconnecting first can reconnect from stale durable state, while
  swallowing a persistence error makes the renderer report an account transition
  that did not survive restart.
- **Evidence:** `brainrouter-desktop/electron/host/queries.ts`,
  `brainrouter-desktop/electron/host/mcpLifecycle.test.ts`

---

## Dashboard (`brainrouter-dashboard/`)

### 14. Pages: `'use client'` + memoized SDK client + hooks package + `AuthGuard`

Every data page is a `'use client'` component that gets its API client via
`useMemo(() => getClient(), [])` from `lib/client.ts` (wrapping the SDK's
`BrainRouterClient`), fetches through `@kinqs/brainrouter-hooks` hooks (e.g.
`useScenes`), and wraps its content in `<AuthGuard>`. Auth tokens live in
localStorage (`lib/client-auth.ts`) with a single in-flight refresh promise so a
burst of 401s triggers one `/refresh`. Do **not** add server components that fetch,
or hand-rolled `fetch()` calls — go through the SDK + hooks.

- **Why:** the dashboard deploys as a static/edge client against a user-local brain
  server; the shared refresh single-flight only works when everything routes
  through `getClient()`.
- **Evidence:** `brainrouter-dashboard/app/scenes/page.tsx:1`, `brainrouter-dashboard/lib/client-auth.ts:26`

### 15. ⛔ The server counterpart: per-resource express routers, `requireAnyAuth` + `req.userId` scoping, ALWAYS await

The dashboard's server side is one small express `Router` per resource under
`brainrouter/src/api/routes/` (`memory/stats.ts`, `memory/scenes.ts`, …), each
applying `requireAnyAuth` and passing `req.userId!` into every `memoryEngine` call
for tenant scoping. `memoryEngine` methods are async (PG-backed): **every call in a
route or tool must be awaited** — an unawaited call passed to `res.json` serializes
`{}` and shows 0/NaN/undefined. (See [`04`](04-memory-engine-and-mcp-server.md) rule 3.)

- **Evidence:** `brainrouter/src/api/routes/memory/stats.ts:8`

### 16. Dashboard styling: canonical tokens in `globals.css`, dark-primary, self-hosted fonts

Visuals use the canonical design tokens at the top of `app/globals.css`
(`--surface-*`, `--text-*`, `--accent`, `--heat-*`, `--radius-*`, `--shadow-*`);
dark is the primary theme, light is the override; legacy var names are remapped to
new values (not deleted) so old components restyle automatically. Fonts are
Geist/Geist Mono via the `geist` npm package — **no web-font CDN** (Cloudflare
pages must not depend on external CDNs). Elevation shadows are neutral (never an
accent-colored glow); the single accent radial (`--aura-signal`) is reserved for
marketing hero/headers.

- **Evidence:** `brainrouter-dashboard/app/globals.css:1`, `brainrouter-dashboard/app/layout.tsx`

---

## Testing note

Desktop has **no Vitest/jsdom/RTL**: `electron/**` tests compile to `dist-electron`
and run via `node --test`; `src/**` renderer tests run via `tsx --test` and must be
pure view-model/formatting tests (no DOM, no Electron APIs), deep-importing core
`dist` where needed. Extract logic into pure functions (`isAllowedNavigation`,
`buttonClass`, `scrubCliSecrets`) to test it. Full detail in [`07`](07-testing.md).
