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

## Acceptance (needs real hardware + certs — tracked as CP-B)

1. `npm run dist:mac` on an Apple-silicon Mac with the certs → a signed, notarized
   `.dmg` for both arches; Gatekeeper opens it without a warning.
2. Grant Accessibility + Screen Recording in System Settings → the chat agent can
   `screenshot` then `left_click`/`type` a real app end-to-end.
3. `npm run dist:win` → an `.nsis` installer that loads the native module.
