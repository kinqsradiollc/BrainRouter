# BrainRouter Desktop (alpha)

A native desktop shell (**Electron + React + Vite**) over the unchanged
`@kinqs/brainrouter-core` agent runtime — the same engine the CLI uses. The agent
runs in an Electron `utilityProcess` (one per workspace); the renderer is a React
SPA that talks to it over a typed IPC bridge (`@kinqs/brainrouter-agent-protocol`).

This document covers **building distributable installers**. For the app
architecture see Thread M in [`../brainrouter-roadmap/0.4.15.md`](../brainrouter-roadmap/0.4.15.md).

---

## Quick start (run from source)

```bash
npm install                 # from the monorepo root (hoists all workspaces)
npm run start -w brainrouter-desktop   # build deps + app, then launch Electron
```

## Building installers

Packaging is handled by [electron-builder](https://www.electron.build/) and
configured in [`electron-builder.yml`](electron-builder.yml). The scripts first
build the app (`package:prepare` → deps + electron + renderer) and then package it:

```bash
npm run dist          # installers for the CURRENT OS
npm run dist:win      # Windows  → NSIS setup .exe + portable .exe
npm run dist:linux    # Linux    → .deb + AppImage + .rpm     (run on Linux/WSL)
npm run dist:mac      # macOS    → .dmg + .zip                (run on macOS)
npm run dist:dir      # unpacked app only — fast smoke test, no installer
npm run verify:package # assert the agent host + core made it into the package
```

Artifacts land in **`brainrouter-desktop/release/`** (gitignored). Each build also
writes the electron-updater feed (`latest.yml` / `latest-linux.yml` /
`latest-mac.yml`).

### Which OS builds what

A given OS can only natively build its own (and some cross) targets:

| Target | Build on | Notes |
|---|---|---|
| Windows `.exe` (NSIS + portable) | Windows | ✅ verified locally |
| Linux `.deb` + `.AppImage` + `.rpm` | Linux / **WSL** | run `npm run dist:linux` inside WSL |
| macOS `.dmg` + `.zip` | macOS | can't be built on Windows/Linux — use a Mac or CI |

To produce **all three** from one place you need a CI matrix
(macOS + Windows + Linux runners). That release workflow is intentionally **not**
included here — see [Releases & CI](#releases--ci-your-responsibility) below.

---

## Code signing (unsigned alpha)

Builds are **unsigned** today. They install and run, but the OS shows a warning:

- **Windows** — SmartScreen "Windows protected your PC". Click **More info → Run anyway**.
- **macOS** — Gatekeeper "unidentified developer". **Right-click → Open**, or
  `xattr -dr com.apple.quarantine "/Applications/BrainRouter.app"`.
- **Linux** — `.deb`/`.rpm`/AppImage need no signing.

Signing is pre-wired but inactive (`mac.hardenedRuntime` is on, ready for
notarization). To sign later, set the standard electron-builder secrets and
rebuild — no config change needed:

- Windows: `CSC_LINK` (base64 .pfx) + `CSC_KEY_PASSWORD`
- macOS: `CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`

---

## Auto-update (scaffolded, inactive)

The main process wires [electron-updater](https://www.electron.build/auto-update)
via [`electron/updater.ts`](electron/updater.ts), but it is a **no-op** unless
**all** of these hold, so default alpha builds never phone home:

1. it's a packaged build (`app.isPackaged`), **and**
2. `BRAINROUTER_UPDATE_CHANNEL` is set (e.g. `latest`), **and**
3. the optional dependency is installed.

To activate (once builds are signed and a GitHub Release exists):

```bash
npm install electron-updater          # add to dependencies
# build/run with BRAINROUTER_UPDATE_CHANNEL=latest
```

Update events are broadcast to the renderer on the `update-event` IPC channel
for a future "update available / downloading / ready" UI.

---

## Releases & CI (your responsibility)

The GitHub Actions release matrix (tag → build on macOS/Windows/Linux → attach
`.exe`/`.dmg`/`.deb` to a GitHub Release) is **owned by you** and is not added by
this change. The `publish:` block in `electron-builder.yml` (provider `github`,
`kinqsradiollc/BrainRouter`) is ready for it; releases only upload when
electron-builder is invoked with `--publish`. Adjust `owner`/`repo`/`maintainer`
before a public release.

---

## Environment notes (important)

These reflect the repo state at the time of writing — worth knowing if a build
behaves unexpectedly:

- **electron-builder is pinned to `25.1.8`**, not the latest 26.x. electron-builder
  26 requires Node ≥ 20.19; the repo's local toolchain has been seen on Node
  20.10, where 26.x crashes with `ERR_REQUIRE_ESM`. 25.1.8 supports Node 14+ and
  works on both local and CI. Bump to 26.x once everyone is on Node ≥ 20.19/22.
- **`@modelcontextprotocol/sdk` and `chalk` are direct dependencies here on
  purpose.** `@kinqs/brainrouter-core` imports them but doesn't declare them
  (they resolve via monorepo hoisting in dev). electron-builder only bundles
  *declared* deps, so without these two the packaged agent host would crash with
  `Cannot find module '@modelcontextprotocol/sdk/...'`. **Do not remove them** as
  "unused" — they are runtime deps of the bundled `core`. (The cleaner long-term
  fix is to declare them in `packages/core/package.json`.)
- **TypeScript 6 caveat.** If the monorepo root is mid-migration to
  `typescript@^6` while the per-package `tsconfig.json`s still lack an explicit
  `rootDir`, `tsc` emits `TS5011` and the dep builds fail. The committed code and
  CI use TypeScript `5.9.x`, where the builds pass. Until any TS6 migration is
  completed (add `rootDir` to the tsconfigs) or reverted, build with the 5.x
  toolchain.

## Layout

```
electron/            main + preload (.cts→.cjs) + agent host (utilityProcess) + updater
src/                 React renderer (Vite → dist/)
electron-builder.yml packaging config (targets, icons, publish, asar)
build-resources/     app icon (icon.png 512px → electron-builder generates .ico/.icns)
scripts/             verify-package.mjs and dev helpers
release/             build output (gitignored)
```
