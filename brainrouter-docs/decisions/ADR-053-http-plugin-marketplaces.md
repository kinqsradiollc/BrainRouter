# ADR-053 — HTTP plugin marketplaces (and the private-catalog auth helper)

**Status:** PROPOSED — awaiting owner review. · **Builds on:** the plugin marketplace system
(`packages/core/src/plugin/marketplace.ts`, git + local sources), ADR-039's SSRF guard
(`validateUpstreamTarget` / the upstream allowlist), and ADR-052 P4.6 (the marketplace auth helper,
which this unblocks). · **Informed by:** the "http later" TODO the marketplace fetch has carried
since it shipped; no external project is named or copied.

**Date:** 2026-08-31

> A plugin marketplace can be a local directory or a git repo today. The third source the code
> already *classifies* — an `https://…/catalog.tgz` tarball — returns "not supported yet." That gap
> is why ADR-052 P4.6 (an auth helper that mints a header for a **private** catalog) has nothing to
> attach to: there is no HTTP fetch to authenticate. This ADR builds the HTTP fetch — safely — and
> lands the auth helper on top.

---

## 1. Where the code is today

- **Two of three sources work.** `fetchMarketplace(entry)` (`plugin/marketplace.ts:308`) handles
  `local` (read in place) and `git` (`git clone --depth 1`), and returns
  `http marketplace sources are not supported yet` for `http`. `classifyMarketplaceSource` already
  recognises an `https://….(tgz|tar.gz)` URL as `http` (`:193`), so the source type is real; only
  the fetch is missing.
- **The fetch is synchronous.** `fetchMarketplace` returns a value, not a promise — fine for a
  local read and a `spawnSync` clone, but an HTTPS download + tar extraction wants async. That
  signature is the real reason http was deferred, and every caller assumes sync.
- **We already own the safety primitive.** ADR-039's `validateUpstreamTarget`
  (`provider/routing/transport.ts:246`) is the same SSRF guard the re-embed and egress paths use —
  it rejects non-HTTPS and non-allowlisted origins. An HTTP marketplace fetch is exactly the kind
  of user-config-driven outbound request that must pass through it.
- **P4.6 has no seam.** ADR-052's auth helper (a command that mints an `Authorization`/token
  header, secret kept in Settings) is meaningless without a request to attach headers to. HTTP
  marketplace fetch is that request.

---

## 2. Decisions

**D1 · An async HTTP marketplace fetch, SSRF-guarded.** Add `fetchHttpMarketplace(entry, deps)`:
validate the URL through `validateUpstreamTarget` (HTTPS + allowlist; a blocked origin returns a
clear error, never a silent fetch), download the tarball with an **injected fetch** (default
global `fetch`), and extract it to a staging dir with an **injected extractor** (default a
`tar -xzf` spawn), returning the same `FetchedMarketplace { dir, cleanup, revision }` shape as git.
The download is bounded (a max-bytes cap) so a hostile URL can't exhaust disk. Pure-enough to
unit-test end to end by injecting a fake fetch + a local tarball.

**D2 · The fetch path becomes async at the seam, not everywhere.** `fetchMarketplace` gains an
async sibling `fetchMarketplaceAsync(entry, deps)` that delegates to the existing sync body for
`local`/`git` and to `fetchHttpMarketplace` for `http`. Callers that can already await adopt the
async form; the sync `fetchMarketplace` keeps returning its explanatory error for `http` so nothing
regresses. (Making the whole install pipeline async is mechanical follow-up, not a decision.)

**D3 · The private-catalog auth helper (ADR-052 P4.6).** A `MarketplaceSource` may declare a
`headersHelper` — a command run *before* the fetch whose stdout is a JSON header map merged into
the request (e.g. a short-lived bearer token). The helper's own secret lives in the Settings store
like any provider secret (write-only, stripped from snapshots — the existing rule); the command is
shown before it runs, matching the plugin-install consent posture. Absent ⇒ an unauthenticated
fetch, exactly as a public catalog.

---

## 3. What this is not

- **Not a new package format.** The tarball contains the same marketplace manifest a git/local
  source has; only the transport differs.
- **Not arbitrary code on fetch.** The tarball is data — a manifest + plugin sources — extracted to
  a staging dir and read, never executed. Plugin install keeps its existing advisory gate.
- **Not a widening of the SSRF surface.** The fetch validates against the *same* upstream allowlist
  as every other outbound path; an HTTP marketplace can reach only origins already trusted.
- **Not a credentials-in-config feature.** The auth helper mints headers at fetch time; a static
  token in `config.json` is not the supported path.

---

## 4. Delivery board

- **P1 — `fetchHttpMarketplace`** (D1): the SSRF-guarded, bounded, injected-fetch/extract function +
  `fetchMarketplaceAsync` seam; unit-tested end to end with a fake fetch and a local tarball.
- **P2 — `headersHelper`** (D2/D3 = ADR-052 P4.6): the config field, the mint-before-fetch step,
  and the Settings-stored secret; tested with a fake helper command.
- **P3 — Async install adoption**: thread `fetchMarketplaceAsync` through the install/update path so
  an HTTP catalog installs like a git one. Mechanical.

---

## 5. How this will be judged

1. `brainrouter plugin marketplace add https://cdn.example.com/catalog.tgz` fetches, extracts, and
   lists its plugins — or fails with a *named* SSRF/allowlist reason, never a silent success.
2. A tarball larger than the cap is rejected, not written to disk.
3. A private catalog fetch carries the `headersHelper`'s minted token; the token never lands in
   `config.json` or a snapshot.
4. The sync `fetchMarketplace` still refuses `http` with its explanatory error — no regression for
   callers that haven't adopted the async seam.
