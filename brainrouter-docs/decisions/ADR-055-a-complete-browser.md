# ADR-055 — A complete browser: Chrome parity for the human, human parity for the agent

**Status:** ACCEPTED — phased implementation on `release/0.4.22`; P1 (images the model can see) shipped. · **Builds on:** ADR-024 (the browser action loop and lanes — §5
there was decided but its browser rows were never built; this ADR refines and delivers them),
ADR-037 (credentials the page cannot read), ADR-039/043 (SSRF and egress policy), ADR-044 (web pages
the agent can actually read), ADR-046 (surfaces that vouch for themselves), ADR-052 (the restricted
seat), and the first-class browser program (#842, #890, #894, #899). · **Informed by:** a study of
how contemporary agent harnesses expose a browser to a model and how a desktop browser earns a
user's daily use; no external project is named or copied — every gap below is grounded in our own
code. · **Related:** `brainrouter-rules/06-desktop-and-dashboard.md` §4a (amended by D3).

**Date:** 2026-09-02

> The in-app browser is a real Chromium: main-owned `WebContentsView` tabs on a per-workspace
> partition, a 39-tool agent surface, SSRF-fenced navigation, redacted snapshots, a visible agent
> cursor, and an e2e harness that proves 50 tabs and 1,000 switches without a crash. It is good.
> It is not yet *the* browser — for either seat. A human reaches for Chrome the moment they want a
> bookmark, their history, a PDF, fullscreen video, or "what does this site have permission to
> do?". The agent, for its part, cannot see the page in pixels, sees only a flat list of the
> on-screen widgets, has no way into an iframe or a shadow root, gets no receipt for what a click
> changed, loses a tab forever when a site asks for human verification, and cannot read the file it
> just downloaded. This ADR decides what "complete" means for both seats, on the engine we already
> have, and delivers it as PR-sized rows.

---

## 1. Where the code is today

**One engine, two seats, one protocol.** `brainrouter-desktop/electron/browser/` (~8.5k lines,
19 unit-test files) owns the browser: `browserViewManager.ts` (1,732 lines) allocates
`WebContentsView`s with `sandbox`/`contextIsolation`/`webSecurity` on and `backgroundThrottling`
off (`:252-270`), on the workspace partition (`browserPartitionForWorkspace`, `:249`) with per-chat
tab sets (`setSession`, `:579`) and per-chat wipes (`clearSessionData`, `:586`). `protocol.ts`
is the renderer↔main command union (`BrowserCommand`, `:125-165`) and the state/event shapes; the
human chrome (`src/panels/BrowserPanel.tsx`, 931 lines) and the agent share the same ops. The agent
enters through `packages/core/src/browser/control.ts` (`BrowserControlCommand`, `:64-100`), bridged
by `createBrowserControlBridge` (`electron/host.ts:335`) into `browserAgentControlManager.ts`
(chat-scoped tab authority, visible-operation FIFO, takeover aborts) and mapped by
`browserAgentAdapter.ts:58-132` onto `BrowserCommand`. The 39 model-visible tools live in the
bundled extension `packages/core/extensions/browser/index.js` (`browser_*`; read / network /
computer tiers) and are gated to the top-level, non-silent, local-desktop agent by
`browserUseAvailableFor` (`control.ts:166`). The e2e/benchmark harness
(`brainrouter-desktop/scripts/browser-e2e.mjs`, `README-browser-benchmarks.md`) runs loopback-only
gates: `tabs.one/twenty/fifty`, `stability.switches/cycles`, `same-tab.retention/no-reload`.

**Chrome parity for the human — what the chrome has and lacks.** Grounded in `BrowserPanel.tsx`,
the shortcut handler (`browserViewManager.ts:1468-1490`), the context menu (`:1452-1466`), and
the policy modules.

| Affordance | Today | Evidence |
|---|---|---|
| Tab strip: favicon, spinner, crash badge, audio + mute, new/close/reopen/reorder (drag + keys) | ✅ | `BrowserPanel.tsx:710-740`, `tabState.ts` |
| Omnibox: URL or search; typed text falls through to a Google search | ✅ hardwired | `protocol.ts` `normalizeBrowserAddress` |
| Omnibox autocomplete from history/bookmarks; search-engine choice | ❌ | no history store exists |
| Bookmarks (⌘D, bar, manager) | ❌ | no store, no UI |
| Browsing history (⌘Y, "recently closed" beyond a count) | ❌ | only `closedTabCount` + reopen stack |
| New-tab page | ⚪ blank `data:` page | `BROWSER_BLANK_URL` |
| Back/forward/reload/stop; ⌘T/W/⇧T/L/F/R/1-9/±/0; Alt←→ | ✅ | `:1468-1490` |
| ⌘⇧[ ] tab cycling, Esc = stop, ⌘⇧J downloads, ⌘⇧A tab search, pinned tabs | ❌ | not handled |
| Find in page (prev/next/close) | ✅ | `find`/`stop-find` ops |
| Zoom (per tab, ±/0) | ✅ | `set-zoom`; native-view bounds fixed in #894 |
| Downloads: drawer, pause/resume/cancel/open/reveal; save to the OS Downloads folder | ✅ | `browserDownloadManager.ts`; `prepareSavePath` → `app.getPath('downloads')` (`:299-300`) |
| Site permissions: geolocation, notifications, camera/mic, fullscreen, idle-detection, pointer lock prompt; everything else fails closed | ✅ | `browserPermissionPolicy.ts` |
| Per-site permission memory across restarts | ⚪ geolocation only | `browserWorkspaceStore.ts` ("reviewed geolocation decisions"); other grants in memory |
| Site-info popover (padlock → origin, certificate, granted permissions, clear site data) | ❌ static indicator | `BrowserPanel.tsx:753` |
| JS dialogs, `beforeunload`, certificate errors | ✅ as prompts | `BrowserDialogPrompt` kinds; `safeDialogs` |
| HTTP basic-auth prompt (human types; proxy auth refused) | ✅ | `httpAuthPrompt.ts`; `:781-800` |
| Popups → new tab, inheriting the opener's agent policy | ✅ | `openWindow` `:915-940` |
| Context menu: open link in new tab, edit roles, back/forward/reload, inspect (dev) | ⚪ minimal | no copy-link/copy-image/open-externally/view-source/save |
| PDF viewer | ❌ | `plugins` not enabled — PDFs become downloads |
| HTML5 fullscreen (video) | ❌ | permission is promptable but no `enter-html-full-screen` handling |
| Print / save as PDF | ❌ | — |
| Pop-out window / detach tab | ❌ | one panel in the workspace column |
| Device emulation, agent-cursor toggle, DevTools drawer (elements/console/network), Reset browser | ✅ | `BrowserPanel.tsx:802-822` |
| Session restore per workspace (tab locations) | ✅ | `browserWorkspaceStore.ts` |
| Spellcheck; ordinary Chrome user agent + locale headers | ✅ | `:268`, `browserProfile.ts` |
| Password manager, autofill, payments, extensions, sync, incognito, reader, translate, cast | ❌ | by policy — see §3 |

**Human parity for the agent — what the model can and cannot do.**

- **It never sees pixels.** `browser_screenshot` saves a PNG under
  `.brainrouter/browser/screenshots/` and returns a *path* (`browserAgentAdapter.ts:298-317`);
  no tool result carries an image part — the only image seam is the *user* turn
  (`agent/runtime/contextPreparationPhase.ts:72`, mapped to provider image blocks in
  `agent/transport/nativeProviders.ts:200`), and `read_file` names images without inlining them.
  ADR-024 §5.2 step 6 (vision coordinate with a post-hit semantic check) was never built.
- **The snapshot is a flat list of on-screen widgets.** `semanticSnapshotScript`
  (`browserViewManager.ts:161-196`) scans `a,button,input,textarea,select,option,summary,nav,
  main,header,footer,[role],[data-testid],h1-h3,img` (first 2,500), keeps only *visible-in-
  viewport* nodes, caps at 500 rows, and returns role/name/value/rect with no hierarchy and no
  body text (paragraphs, lists, tables come only from the separate `page.text`). It does not
  enter iframes (any origin) or shadow roots; anything scrolled off-screen is absent, so a long
  page is scroll → re-snapshot loops.
- **Locators are ref-or-testid only.** Every `page.*` target is an opaque revision-bound ref or a
  workspace UI-map `testID` (`control.ts` `RefTarget`). Role+name, visible text, label — ADR-024
  §5.2 strategies 3–6 — do not exist; the human `find` op is not mapped for the agent.
- **No action receipt.** A mutating op returns `ok` and the new revision; "click returned no
  error" is the only success signal. `browser_wait` (load state / URL / text / ref) is the manual
  verify step, so each real step is ≥3 model calls (act, wait, snapshot).
- **Handoff is one-way.** `humanChallengeReason` (`browserHumanChallenge.ts`) detects a
  verification page; `updateHumanChallenge` (`:1560-1569`) then *releases* agent control of the
  tab for good and the agent's next command fails with "Complete it in the visible Browser tab,
  then ask the agent to continue" (`:477-484`). Nothing tells the agent the human finished; the
  same applies to a human takeover (`handleUserTakeover` aborts in-flight ops, no resume). And a
  human cannot *give* the agent a tab: authority is "tabs this chat opened" (rules §4a).
- **Downloads leave the jail.** Agent-leased downloads save to the OS Downloads folder, outside
  the workspace root the file tools are jailed to — the agent can list a download but never read it.
- **The restricted seat is incoherent for the browser.** ADR-052 P3 drops `network`-kind tools
  (`agent.ts:2608`) and clamps to the read tier, so `browser_navigate` disappears while
  `browser_snapshot`/`browser_console` stay listed — a seat that "cannot browse" still advertises
  browser observation.
- **The safety floor is right and must not move:** ordinary Chrome UA (no fingerprint games),
  agent navigation fail-closed on private addresses (`browserDestinationPolicy.ts`), password/
  secret values redacted in snapshots, console/network stripped of cookies and bodies, proxy auth
  refused, a bounded agent-tab cap of 4 (`reapAgentTabs`, `:625`), every request stamped with its
  owning chat session (`browserAgentControlManager.ts` `handleRequest`), ADR-024 §D's rejection
  of stealth and challenge-solving.

---

## 2. Decisions

**D1 · One engine, one protocol, two complete seats.** No second browser, no `<webview>`, no
external attach: the human chrome and the agent both get everything through `BrowserCommand` /
`BrowserControlCommand` on the existing `WebContentsView` manager, and every new capability is
added to the *protocol first* so both seats gain it. "Complete" is defined by the two tables in
§1: each ❌/⚪ row becomes ✅ or an explicit §3 non-goal. *Acceptance: no row in §1 is left
undecided, and no new capability exists for one seat only unless §3 names why.*

**D2 · The agent sees what the human sees.** (a) **Vision:** `browser_screenshot` (and any
receipt that asks for one) returns an *image part* alongside the text digest when the active
model is vision-capable per the models catalog; a tool result gains an `images` seam that
`contextPreparationPhase` already understands for user turns; `cli.browser.vision`
(`auto` | `off`) forces the text-only path. Images stay bounded by `MAX_BROWSER_IMAGE_BYTES`.
(b) **Coordinates with a conscience:** `page.click`/`hover`/`drag` accept `{x, y}` in the CSS
pixel frame of a named screenshot revision; the adapter resolves the hit element first and
returns it in the receipt, refuses a coordinate hit on a credential input (the `valueIsSensitive`
rule), and rejects a stale revision (`STALE_PAGE`) — exactly ADR-024 §5.2 step 6. (c) **Snapshot
v2:** an *outline* (landmarks → headings → sections) with bounded body text, lists, and tables
(reusing `pageCapture.ts` `tableToMarkdown`), interactive nodes as today, `scope: 'viewport' |
'page'` (page = scrolled-out nodes included, flagged; `display:none`/hidden nodes stay excluded —
that exclusion is a secrecy guard), open shadow roots walked, iframes walked through Electron's
main-process frame handles so cross-origin frames are targetable (refs carry their frame), and
`page.find { text | role+name | label }` returning refs. (d) **Locator ladder** inside the page
script: `ref` → `testId` → `role + exact name` → `visible text` → `label`, ambiguity reported as
`INVALID_REQUEST` with the bounded candidate list, never a guess. *Acceptance: a form field
inside a cross-origin iframe and a control inside a shadow root are each located by role+name
and filled in one call; a vision-capable model receives the screenshot as an image; a text-only
model gets the digest and the run still completes.*

**D3 · Every action returns a receipt; handoff runs both ways.** (a) Every mutating `page.*` op
returns a **`BrowserActionReceipt`** (ADR-024 §5.3, refined): `before/after {revision, url,
title}`, `observed` (`navigated`, `dialog`, `download`, `newTab`, `focus`, `dom`), and the
resolved target — captured in a bounded settle window so Observe → Act → Verify is one call.
Retries still re-observe: a stale ref remains an error. (b) **Human-needed is a state, not a dead
end:** a verification page, a takeover, or an explicit "hand back" turns the tab `humanNeeded
{reason}`; the agent's next command fails with `HUMAN_NEEDED` and `browser_wait { human: true }`
resolves (bounded, ≤10 min) when the human presses **Hand back to agent** or navigation leaves the
challenge — control is re-granted with its policy re-derived, not lost. The human sees a banner
("You took over — the agent is paused · Resume"). (c) **Share a tab:** a tab-strip action *Let
the agent use this tab* grants the active chat session authority over a human tab (badge on the
tab; revocable from the same menu or by takeover). This is the only widening of rules §4a and it
is explicit, per-tab, per-chat — the rules file is amended in the same PR. ADR-024's "attached
external browser" lane is **declined** by this decision: the signed-in session the lane was for
already lives in the shared workspace partition. *Acceptance: a scripted challenge page hands the
tab to the human and the agent resumes on hand-back without a new user prompt; a human tab shared
with the agent is driven, and revocation makes the next agent command fail with
`ownership_mismatch`.*

**D4 · Files like a human.** Agent-leased downloads land in a workspace **inbox**
(`.brainrouter/browser/downloads/`, gitignored, size-capped) so `read_file` can read them and the
receipt names the workspace-relative path; human downloads keep the OS folder. `page.selection`
returns the current selection text; a bounded page-scoped clipboard (`page.clipboard` read/write
of *text*, never the OS clipboard) lets the agent copy-paste within the browser. Uploads stay
workspace-relative and staged (`uploadStaging.ts`). *Acceptance: the agent downloads a report from
a loopback fixture and reads it in the next call; a human download is unchanged.*

**D5 · Chrome parity for the human.** Delivered as ordinary chrome, all local, no network
features: **bookmarks** (⌘D, drawer + optional bar) and **history** (⌘Y; per-workspace visit log
bounded at 5,000 entries; `clear-data` `history` now clears it too) in `browserWorkspaceStore`;
**omnibox autocomplete** from history + bookmarks only (no remote suggest) with a
`cli.browser.searchEngine` knob (default the current engine); a **new-tab page** (recent +
bookmarks, a local `data:` page); **tab search** (⌘⇧A), **pinned tabs**, ⌘⇧[ ] cycling, Esc =
stop, ⌘⇧J downloads; a real **site-info popover** (origin, TLS state, granted permissions with
revoke, clear site data) and **per-site permission memory** for every promptable permission;
**PDF viewer** in-tab (`plugins: true` on the view; agent and human alike); **HTML5 fullscreen**
(`enter/leave-html-full-screen` → the surface fills the window, Esc exits); **print / save as
PDF** (`printToPDF` into `.brainrouter/browser/prints/`, native print dialog); context-menu parity
(copy link, copy image address, open in system browser, view source, save page); and, last and
optional, a **pop-out window** hosting a detached tab on the same manager. *Acceptance: every
✅-pending row in §1's table has a renderer affordance with `title`/`aria-label`, a keyboard path,
and a devBridge mock (rules §4).*

**D6 · Safety unchanged, made coherent.** The restricted seat (ADR-052) removes the whole
`browser-control` runtime port — no observation without navigation. **Certificate decisions are
human-only:** `dialog.respond` may not accept a `certificate` prompt; the agent gets `DENIED`
with the reason. Permission responses stay `computer`-tier approvals. A coordinate click never
reaches a credential input; screenshots never include an HTTP-auth or certificate prompt (those
are separate windows already). Stealth, fingerprint spoofing, and challenge-solving remain
rejected (ADR-024 §D). *Acceptance: the invariant tests in §5.3 pass.*

**D7 · Qualification the harness can prove.** `browser-e2e.mjs` gains an **agent-as-human
battery** against loopback fixtures only: sign-in with redirect, a multi-step form with an iframe
field and a shadow-DOM select, file upload and download round-trip, modal dialog, permission
prompt, popup window, PDF open, HTML5 fullscreen, a fake verification page → hand-back → resume,
and a shared human tab. Each scenario is driven through `browser_*` tools by a scripted model and
must finish with receipts only (no blind click). *Acceptance: the battery is a required gate
beside `tabs.fifty` and `stability.*`; snapshot v2 on the 5k-node fixture stays under a measured
bound recorded in the benchmark report.*

---

## 3. What this is not

- **Not extensions, not a store.** Chromium extensions in an Electron host are a partial,
  brittle surface and a supply-chain door; the built-in tools are the extension.
- **Not sync, profiles, passwords, autofill, payments, or passkeys.** ADR-037's stance stands:
  the product never holds a credential the agent could reach; the human types into pages, and the
  browser never offers to remember. Incognito is unnecessary — the workspace partition plus
  *Reset browser* / *Clear site data* is the isolation model.
- **Not an external-browser attach lane.** Declined (D3c); "use my signed-in session" is served
  by the shared partition plus *share a tab*.
- **Not CAPTCHA solving, identity spoofing, or stealth.** Human-needed is a first-class state
  precisely so the product never pretends.
- **Not a CLI or headless browser lane.** `browserUseAvailableFor` is unchanged: sub-agents,
  workers, remote-brain and CLI seats stay unavailable rather than spawning a second browser.
- **Not reader mode, translate, picture-in-picture, casting, or media hubs.** Nice, not parity
  that a task depends on; each is a later, separate decision.
- **Not a rewrite.** Every row lands on `browserViewManager` / `protocol.ts` /
  `browserAgentAdapter` / the extension; the boundary rules from ADR-024 §D (wire vocabulary in
  agent-protocol, policy in core, Electron behavior in the adapter) apply to each PR.

---

## 4. Dependency-ordered delivery board

Rows are one PR each into the current release branch; a row is done when its acceptance line in
§2 holds and its harness gate (D7) exists.

- **P1 — Images the model can see** (D2a) — ✅: a browser screenshot rides a companion
  `role:'user'` image message (the one wire shape every provider accepts), flushed AFTER the
  tool results so the batch stays valid; `cli.browser.vision` (`auto`|`off`, default auto) gates it;
  `browserScreenshotImageHandoff` reads only the in-tree `.brainrouter/browser/screenshots/` PNG/JPG
  and fails closed on anything else. Core-only (no desktop change — the artifact path already exists).
- **P2 — Coordinates with a conscience** (D2b): `{x, y}` targets on click/hover/drag with hit
  resolution, credential refusal, and stale-revision rejection. Depends on P1.
- **P3 — Snapshot v2** (D2c): outline + text/tables/lists, `scope`, shadow roots, frame-aware refs,
  `page.find`. Adapter + page script + protocol.
- **P4 — Locator ladder** (D2d): role+name / text / label targets across every `page.*` op;
  ambiguity as a bounded candidate list. Depends on P3.
- **P5 — Action receipts** (D3a): `BrowserActionReceipt` on every mutating op; `browser_wait`
  becomes the exception, not the rule.
- **P6 — Human-needed both ways** (D3b): `HUMAN_NEEDED`, `browser_wait { human }`, hand-back
  button, takeover banner + resume.
- **P7 — Share a tab** (D3c): per-tab, per-chat grant + badge + revocation; rules §4a amended.
- **P8 — Files like a human** (D4): downloads inbox, `page.selection`, page-scoped clipboard.
- **P9 — Human chrome I** (D5): bookmarks, history, omnibox autocomplete, search-engine knob,
  new-tab page, tab search, pinned tabs, the missing shortcuts.
- **P10 — Human chrome II** (D5): site-info popover, per-site permission memory, PDF viewer,
  HTML5 fullscreen, print/save-as-PDF, context-menu parity.
- **P11 — Coherent safety** (D6): restricted seat drops the port; certificate prompts human-only;
  the §5.3 invariant tests.
- **P12 — The battery** (D7): agent-as-human scenarios + snapshot bound in the harness; required
  gate.
- **P13 — Pop-out window** (D5, optional, last): detached tab on the same manager.

---

## 5. How this will be judged

1. **The battery passes with tools only.** Every D7 scenario completes through `browser_*` calls
   on loopback fixtures, each mutating step carrying a receipt, with no coordinate click that
   lacks a resolved element.
2. **Parity is decided, not implied.** Each row of §1's table is ✅ or named in §3 — nothing
   silently absent.
3. **The floor held.** Tests prove: no credential value in any snapshot, receipt, or find result;
   a certificate prompt is unreachable by the agent; a private-address navigation without a human
   grant fails closed; a restricted session lists no `browser_*` tool; every image part is under
   the byte cap.
4. **It is still fast.** `tabs.fifty`, `stability.switches/cycles`, and `same-tab.*` stay green;
   snapshot v2 and the receipt settle window have recorded bounds in the benchmark report.
5. **It is honest.** Every unsupported op names its reason (`unsupported`, `HUMAN_NEEDED`,
   `DENIED`), and the human chrome tells the user when the agent is paused, sharing, or handed back
   (ADR-046).
