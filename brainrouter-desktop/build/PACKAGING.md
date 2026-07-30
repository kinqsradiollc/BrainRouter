# Desktop packaging — signed + notarized builds

The desktop app ships a native input module (`@nut-tree-fork/libnut`) for the
off-by-default `computer_use` tool. Under the macOS hardened runtime that module
only loads in a **signed + notarized** build, so a real macOS release must be
signed and notarized — an unsigned build will fail to load the native binding at
runtime (and Gatekeeper will block it).

The electron-builder config lives in [`package.json`](../package.json) `build`:
hardened runtime, `build/entitlements.mac.plist` (JIT + `disable-library-validation`
for libnut), `asarUnpack` of the `.node` binaries, per-arch (`arm64` + `x64`)
`dmg`/`zip` targets, and the `afterSign` notarize hook ([`build/notarize.cjs`](./notarize.cjs)).

## What you supply (never committed)

macOS signing + notarization needs your Apple Developer credentials, provided as
environment variables (and a signing certificate in the keychain):

| Variable | What |
|----------|------|
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character Developer Team ID |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | (CI only) base64 of the "Developer ID Application" `.p12` + its password. On a local Mac the cert in your login keychain is used automatically. |

The notarize hook is **fail-open**: with the three `APPLE_*` vars unset it logs
and skips, so dev/CI builds still produce an (un-notarized) app.

## Build commands

```sh
# install the packager + notarizer once (not bundled — kept out of the default install)
npm i -D electron-builder @electron/notarize

# macOS (arm64 + x64 dmg + zip), signed + notarized when APPLE_* are set
npm run dist:mac

# Windows (x64 nsis)
npm run dist:win
```

`dist:mac` / `dist:win` run `npm run build` (compiles `dist-electron` + the Vite
renderer) then invoke electron-builder. Output lands in `release/` (electron-builder default).

## Automated release (CI) — the one-click path

[`.github/workflows/release-desktop.yml`](../../.github/workflows/release-desktop.yml)
runs the whole signed + notarized macOS build on a GitHub `macos-14` runner —
you don't need a local Mac build. Add these **repository secrets** once
(Settings → Secrets and variables → Actions), then trigger the workflow
manually (Actions → "Release — Desktop" → Run workflow) or by pushing a
normal `vX.Y.Z` release tag. The legacy `desktop-v*` namespace remains available
for desktop-only rebuilds:

| Repo secret | Maps to | What |
|-------------|---------|------|
| `MAC_CSC_LINK` | `CSC_LINK` | base64 of your "Developer ID Application" `.p12` |
| `MAC_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` | the `.p12` password |
| `APPLE_ID` | `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | 10-char Team ID |

The workflow installs the packager + notarizer, builds the per-arch app, signs +
notarizes it, runs [`scripts/verify-packaged.mjs`](../scripts/verify-packaged.mjs)
(asserts the installers exist and libnut is asar-unpacked + loadable), and
uploads the `.dmg`/`.zip` as artifacts (and to the GitHub Release on a tag).
Without the secrets it still runs and produces an un-signed build (the notarize
hook fails open), so the pipeline is self-verifying before you add credentials.

`node scripts/verify-packaged.mjs` is also runnable locally against a `dist:mac`
output for the same structural + (advisory) signature checks.

## Acceptance (needs real hardware + certs — tracked as CP-B)

Everything code-side is automated above. The remaining steps are irreducibly
yours — a signing identity + interactive macOS TCC grants:

1. Add the five repo secrets and run the **Release — Desktop** workflow (or
   `npm run dist:mac` locally) → a signed, notarized `.dmg` for both arches;
   Gatekeeper opens it without a warning (`spctl -a -t exec` passes).
2. Grant Accessibility + Screen Recording in System Settings → the chat agent can
   `screenshot` then `left_click`/`type` a real app end-to-end (with the approval
   prompt on each mutating action).
3. `npm run dist:win` → an `.nsis` installer that loads the native module.

## Monorepo note

npm workspaces install `@kinqs/*` as symlinks into the root `node_modules`;
electron-builder rejects symlinks that escape the app directory. The release
workflow runs [`build/dereference-workspace-deps.mjs`](./dereference-workspace-deps.mjs)
after `build:deps` to replace those links with real copies (package.json +
`dist/`). Run it manually before a local `npm run dist:mac`; the next
`npm install` restores the symlinks.
