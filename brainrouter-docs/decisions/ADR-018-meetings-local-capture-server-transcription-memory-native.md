# ADR-018 — Meetings: Local Capture, Server-Default Transcription & Summarization, Memory-Native Storage

**Status:** Accepted (design; phased) · **M0 implementation started** on `feat/meetings-adr018`
(committed, **not merged** — held until Codex's server-managed-models work lands) · **Extends** ADR-012
(providers DB-only), ADR-010 (tenancy), ADR-016 (server-side connectors / desktop-as-client) ·
**Aligns with** the approved spec `server-managed-models-remote-access-and-cve.md` (model gateway,
microservices, remote relay).

> **Account-gated.** Meetings is a **backend product**: it requires a BrainRouter sign-in to store,
> summarize, recall, or share a meeting — the desktop acts as a backend client (ADR-016). A fully
> **offline capture + local-STT** mode still works without an account (privacy fallback, D4), but such
> a meeting is device-local only and gains sharing/org/recall the moment the user signs in.

> **Codex dependency.** Summarization routes through BrainRouter's own hosted provider. The
> `ModelLLMRunner`/`/v1`-gateway wiring is **finalized after Codex's `server-managed-models` work
> lands** (see §"LLMRunner adjustment"). Until then M0 uses the existing per-org `reviewRunner` pattern.

## Context — borrow the idea, keep our spine

The reference is **Meetily** (`openSrc/meetily`), a privacy-first meeting assistant: a Tauri/Rust
desktop app that captures **microphone + system audio locally**, transcribes it on-device with
**Whisper / Parakeet**, and generates **AI summaries** (Ollama / Claude / Groq / OpenRouter /
custom-OpenAI), storing everything in a **local SQLite** file. Its whole premise is data
sovereignty — audio never leaves the machine.

We want the *capability* — "record a meeting → get a live transcript → get a structured summary" —
but our differentiator is that a meeting is not a silo. In BrainRouter a meeting becomes a
**recallable memory** (linked in the cognitive graph, surfaced by recall), its action items become
**Track work items**, its summary is produced by our **server-side LLM router**, and it composes with
tenancy, connectors, and review. And it must land on the direction the approved spec sets:
**server-managed models by default, desktop BYOK optional; microservice topology; PostgreSQL.**

So the decision is: **build Meetings as a memory-native, server-default, privacy-preserving
capability** — reuse Meetily's genuinely hard local audio/STT engine, replace its LLM and storage
layers with ours, and default transcription + summarization to the server while keeping a fully
local/offline path.

### What already exists (reuse)

**From BrainRouter (the integration surface is port/chokepoint-shaped and per-org resolvable):**
- **A `"transcript"` source kind already exists.** `SourceDocumentKind = "transcript" | "file" |
  "tool_output" | "imported_doc"` (`packages/types/src/memory/source.ts:14`). Long transcripts ingest
  through `ingestSource()` (`brainrouter/src/memory/source/ingest.ts:23`) — chunked, citable,
  idempotent by content hash.
- **A domain-ingest template to copy verbatim.** `recordPentestFindings` (`engine.ts:661`) loops
  bounded findings, composes a content blob, calls `upsertEngineeringMemory`, then promotes to org
  scope via `sharing.setMemoryVisibility(...,"org")` (`engine.ts:704`). `recordMeetingSummary` mirrors
  it one-for-one.
- **A single redaction + length chokepoint.** All structured captures pass secret-redaction + a 64 KB
  cap at `engine/memoryOps.ts:164` (via `upsertEngineeringMemory`, `engine.ts:634`). Meeting content
  gets sanitized for free.
- **Graph linkage of summary ⇄ transcript.** `ingestConnectorSources` shows the canonical pattern:
  `ingestSource` the raw doc, then `store.linkRecordSources(userId, recordId, chunkIds)`
  (`brainrouter/src/connectors/knowledgeImport.ts:61,97`) so recall surfaces the summary while
  provenance points back to exact transcript spans.
- **Summarization is already "just another routed call."** `ModelLLMRunner.run()` dispatches through
  the one `modelGateway.dispatch(...)` chokepoint (`brainrouter/src/memory/llm/modelRunner.ts:194`);
  the provider is **DB-resolved per org (ADR-012), never `.env`** (`modelRunner.ts:74-82`), with
  fallback-model retry. The engine already exposes `reviewRunner(lens, orgId)` (`engine.ts:532`) and
  `resolveProviderConfig(store, orgId, "llm")` (`engine.ts:474`). Effort maps via
  `resolveWireEffort(config, effort)` (`packages/core/src/agent/transport/llmTransport.ts:251`).
- **Track carries the linkage fields today.** `WorkItem` has `sessionKey`, **`linkedMemoryIds:
  string[]`** ("Cognitive memory record ids captured for this item"), `codeLinks`, and people as
  handle strings (`packages/types/src/track/entities.ts:142,197,199`); `store.linkWorkItem`
  (`packages/core/src/track/store/items.ts:226`) merges `linkedMemoryIds`. "Meeting → action items"
  works with no new schema.
- **Meeting-transcription connector slots already enumerated.** `ConnectorSource` includes **`gong`**
  and **`fireflies`** (`packages/types/src/connector.ts:37-38`) — plus `slack`/`teams`/`notion`. The
  `ingestConnectorSources` → `linkRecordSources` bridge is the zero-capture-code ingestion path.
- **A proven native-sidecar substrate.** The desktop already forks native helpers:
  `utilityProcess.fork(host.js)` (`brainrouter-desktop/electron/main.ts:248`), and the host spawns
  child processes (`node:child_process` in `host.ts:37`). `desktopCapturer` is already imported for
  screen capture (`computerUse.ts:45`).
- **The deferred/background memory pipeline.** `captureTurn` already backgrounds cognitive extraction
  ("deferred" status), and durable `memory_jobs` + the worker give retry/progress/competing-consumer
  execution (per the spec §3.1). Summary generation runs here — no new job table.

**From Meetily (the capture + DSP + VAD + STT *core* is ~80-90% reusable and verified zero-Tauri; the
command/worker glue and the import/enhance *entry points* are Tauri-coupled — ported, not lifted):**
- **Audio capture + DSP + VAD + STT are reusable as a standalone Rust sidecar.** `audio/pipeline.rs`
  (capture DSP, `rubato` resample to 48 kHz, mix, VAD fan-out), `audio/vad.rs` (`silero_rs`),
  `audio/stream.rs` (`cpal`), the **macOS CoreAudio process tap** via `cidre`
  (`audio/capture/core_audio.rs` — **no BlackHole needed on macOS 14.4+**), per-OS device enumeration
  (`audio/devices/**`), the Whisper engine (`whisper_engine/whisper_engine.rs` on `whisper-rs`, GPU via
  Metal/CUDA/Vulkan compile features), and Parakeet (`parakeet_engine/model.rs` on `ort`/ONNX). All
  depend only on independent crates — they build outside Tauri.
- **A clean summary-template design.** JSON templates of `{title, instruction, format, item_format}`
  sections render to a markdown skeleton + per-section LLM instructions
  (`summary/templates/types.rs:4-35`); provider-aware chunking + map-reduce for local models; a final
  language-detect → translate/normalize pass; an english-cache fingerprint for cheap re-runs
  (`summary/processor.rs`, `summary/service.rs`).
- **A robust summary lifecycle pattern.** `PENDING → completed | failed | cancelled` with
  **backup-and-restore-on-failure** so a good summary is never lost during regeneration
  (`summary/repositories/summary.rs:85-220`).
- **Import & Enhance.** Import an audio file → transcript, or re-transcribe a stored recording with a
  different model/language (`audio/import.rs`, `audio/retranscription.rs`) — the same decode → resample
  → VAD → STT path, batch-tuned. *(These two entry points are Tauri-coupled — port the pipeline and
  wrap it in a server job, per M1; the underlying `pipeline.rs`/`vad.rs`/`whisper_engine.rs` are not.)*

### The exact gaps (build)

| Gap | Where / evidence |
|---|---|
| **Desktop audio/media plumbing is entirely absent** — no `setPermissionRequestHandler`, no mic/`getUserMedia`, no media preload channel | `brainrouter-desktop/electron/main.ts` (grep: none); preload surface `preload.cts:7` has no media channel |
| **macOS system-audio loopback** needs native code (ScreenCaptureKit / CoreAudio tap) | Meetily's `core_audio.rs` is the port target; Electron `desktopCapturer` audio only works on Windows |
| **STT has no home in our stack** — no audio decode/VAD/Whisper anywhere in BrainRouter | build-new; vendor Meetily's `audio/` engine as a sidecar + a server STT service |
| **Server STT microservice** (own image/health/GPU) + durable transcription job | new `services/transcription`; enqueue via `memory_jobs`/worker |
| **`recordMeetingSummary` ingest helper** + a Meetings MCP/REST surface | mirror `recordPentestFindings` (`engine.ts:661`) + `memory_capture_artifact.ts` |
| **Summary template + chunking + language pass** ported to a BrainRouter summary template (not Rust) | port the *design* of `summary/templates` + `summary/processor.rs`; parse structured output via `memory/util/llm-json.ts` |
| **`gong`/`fireflies` connector runtimes** (catalog-only today; only GitHub has real ingestion) | `connectors-platform.md` "Remaining Tasks"; bridge exists (`knowledgeImport.ts`) |
| **No calendar / first-class Person entity** in Track (people are bare handle strings) | `entities.ts:407`; deferred (needs a new entity/connector) |

## Decisions

- **D1 — A Meeting is memory-native, not a new database.** A meeting is a **`session_key`** plus:
  **(a)** its transcript ingested as one `SourceDocument` of `kind:"transcript"` via `ingestSource`
  (chunked, citable); **(b)** a small set of **summary `CognitiveRecord`s** written through
  `upsertEngineeringMemory` (redaction + 64 KB chokepoint), tagged **`metadata.kind:"meeting"`** with
  `meetingId`/attendees/date in metadata; **(c)** those records **linked to the transcript chunks** via
  `linkRecordSources`. A `recordMeetingSummary(...)` engine helper mirrors `recordPentestFindings`,
  including org-visibility promotion for shared meetings. **Use the existing `episodic`
  `MemoryType`** with `metadata.kind:"meeting"` — do **not** add a `meeting_note` `MemoryType`
  (that means synchronized edits across three files + churns golden inventory tests). `metadata.kind`
  is cross-session recallable by default (it is **not** in `SESSION_SCOPED_KINDS`,
  `recall/filters.ts:81`), which is exactly right for meetings.

- **D2 — Summarization is a routed call; do not port Meetily's `llm_client.rs`.** Our LLM router
  already subsumes Meetily's hardcoded-endpoint, per-provider `match`, Claude-special-cased,
  non-streaming client — and adds streaming, fallbacks, and native adapters. The Meetings summarizer
  calls the **org-resolved server-side runner** (the `reviewRunner(lens, orgId)` pattern today; the
  `/v1` model gateway as it lands), so an admin's enabled models + allowed reasoning efforts apply
  automatically. *(Impl note: `reviewRunner`'s `lens` union is `"security"|"code"|"pentest"` — add a
  `"meeting"`/`"summary"` lens or construct the equivalent job-local `ModelLLMRunner`; it is the same
  ~8-line DB-resolved-provider pattern, not new infrastructure.)*
  **Reuse Meetily's *design*, not its Rust:** port the JSON **section-template** system, the
  **provider-aware chunking + map-reduce** for long transcripts, and the **language-detect → translate
  pass** as a BrainRouter *summary template*; route any structured (action-items/decisions) output
  through the `memory/util/llm-json.ts` extraction chokepoint. The desktop **BYOK override** is the
  *same* provider selection that already exists — a personal key can summarize locally, but the
  transcript/summary still lands through the redaction chokepoint. Model pickers consume
  `GET /api/models/catalog`, never a hardcoded list.

- **D3 — Capture is always local; STT is server-default with a local/offline sidecar override.**
  Extract Meetily's capture + DSP + VAD + STT into **one standalone Rust sidecar** spawned by the
  desktop (`utilityProcess.fork`/`child_process.spawn`, the proven `host.js` pattern). VAD already
  segments audio into utterances, so the sidecar emits **newline-delimited JSON** (`transcript-update`,
  etc.) over stdout/loopback-WS to the renderer. Two STT modes behind one interface:
  **(local, private, default-offline)** `whisper-rs`/`ort` in-process in the sidecar;
  **(hosted, opt-in, server-default-online)** the sidecar POSTs each **16 kHz VAD segment** to a
  BrainRouter STT microservice that **shares the same `whisper_engine.rs` code compiled for a server
  GPU**. **Capture + mixing + VAD stay on-device in both modes** (privacy, and it minimizes bytes on
  the wire). The absent media plumbing is built here: `session.setPermissionRequestHandler`, Info.plist
  `NSMicrophoneUsageDescription` + `NSAudioCaptureUsageDescription`, and a new preload media channel.
  `cpal::Stream` is `!Send` — the sidecar pins the capture stream to one thread (as Meetily does).

- **D4 — Privacy-first is the default, matching Meetily's premise and our posture.** Audio is more
  sensitive than the text BrainRouter normally handles. **Audio never leaves the device unless the
  user opts into hosted STT.** A fully **local/offline** meeting (capture + local Whisper + local/BYOK
  summary) is a first-class supported mode. Hosted STT and hosted summarization are **consented,
  org-scoped, and routed through the redaction chokepoint**; shared meetings promote to `visibility:
  "org"` exactly as `recordPentestFindings` does. No prompt/response/audio bodies in telemetry
  (spec §14 "Ask first").

- **D5 — STT is a microservice; summarization runs on the deferred pipeline.** The transcription
  service is an independently deployable process with its own Dockerfile, health/readiness, and a
  GPU-enabled image — enqueued via durable `memory_jobs`/worker, tenant-scoped (spec §11 topology).
  Summary generation runs on the **existing deferred memory pipeline** (background, like `captureTurn`)
  and **reuses Meetily's `PENDING/completed/failed` + backup-restore lifecycle** — but on
  `memory_jobs`, **not** a new `summary_processes` table. Track surfaces the lifecycle as task status.
  **Do not copy Meetily's per-provider API-key columns** — that is the exact anti-pattern ADR-012
  replaced with the provider registry.

- **D6 — Two linkage layers.** **(1)** Meeting memory ⇄ Track via `WorkItem.linkedMemoryIds` +
  `sessionKey` (`store.linkWorkItem`, ships today); action items become `WorkItem`s, attendees map to
  existing assignee/watcher handle strings. **(2)** Meeting-source *ingestion* has two paths that share
  the same memory bridge: native capture (D3) **or** implementing the already-enumerated
  **`gong`/`fireflies` connector runtimes** so teams that already record elsewhere flow transcripts in
  through `ingestConnectorSources` → `linkRecordSources` with **zero new capture code**. A genuine
  **calendar/attendee-identity** link needs a new Track entity or connector — **deferred** (D-nongoal).

- **D7 — Meetings is account-gated; the desktop is a backend client.** Storing, summarizing,
  recalling, or sharing a meeting **requires a BrainRouter sign-in** — the meeting's transcript,
  summary records, and share scope live in the backend (per-user/org, ADR-010/ADR-016), never in a
  local file the way Meetily does it. This is the deliberate difference from Meetily: the value is the
  *shared, recallable, org-scoped* meeting, which only the backend can provide. **Offline fallback
  (D4):** capture + local STT still run signed-out for a device-local transcript; signing in promotes
  it into memory + unlocks sharing. No meeting *sharing* path exists without an account.

- **D8 — Summary sharing is a first-class four-level model: `private | team | org | public`.**
  Meetily has no sharing at all; BrainRouter today has only `private | org` (`MemoryVisibility`,
  `records.ts:145`; `setMemoryVisibility(...,"private"|"org")`, `memorySharingQueries.ts:24`), and "org"
  is currently conflated with "team" (`010_plan_tiers.sql:1` "org = team"). Meetings needs the full
  ladder, so this ADR **extends the visibility model** — every level is considered:

  | Scope | Who can read | Mechanism | Consent / RBAC |
  |---|---|---|---|
  | **private** *(default)* | Owner only | `visibility:"private"` (exists) | none — the default |
  | **team** | Members of a named sub-org group | new `visibility:"team"` + a `team_id` on the record; team = a **Project/group** unit within an org (reuse `ProjectStore` as the team scope initially; a dedicated `teams`/`team_members` table if it must be distinct from projects) | owner sets; must be a member of the target team |
  | **org** | Everyone in the organization | `visibility:"org"` (exists) + `org_id` | owner sets; `memory:share:org` RBAC |
  | **public** | Anyone with the link, **no account** | a **revocable share token** (`meeting_shares` table: `token`, `record_id`, `org_id`, `created_by`, `revoked_at`, `expires_at`) → read-only public endpoint `GET /api/public/meetings/:token` serving the **redacted** summary only (never the raw transcript, never audio) | **explicit, logged publish action** (outward-facing — treated as a deliberate consent step, revocable, optionally expiring) |

  Extensions required: `MemoryVisibility = "private" | "team" | "org" | "public"`; the
  `setMemoryVisibility` union + query (add `team_id`); recall filters honor `team`/`public` scoping
  (`recall/filters.ts`); a `meeting_shares` table + public read route (rate-limited, redaction
  chokepoint, no auth). **Publishing to `public` is the one outward-facing action** — it is explicit,
  audited (`created_by`), and revocable; it never exposes raw audio or the full transcript, only the
  summary. Downgrading a scope (e.g. `public → private`) revokes the token immediately.

## Architecture

```
 DESKTOP (Electron)                                        BACKEND (brainrouter, microservices)
 ┌───────────────────────────────────────────┐            ┌───────────────────────────────────────────┐
 │ Rust capture sidecar (utilityProcess.fork) │            │ transcription service (GPU image, own       │
 │  cpal mic + CoreAudio/WASAPI system tap    │            │   health) — shares whisper_engine.rs (NEW)  │
 │  → mix → VAD segments (ALWAYS local)       │            │ memory engine: ingestSource(kind:transcript)│
 │        │                     │             │            │   + recordMeetingSummary → upsert chokepoint│
 │  ┌─────▼─────┐        ┌──────▼──────────┐  │            │   → linkRecordSources (transcript⇄summary)  │
 │  │ local STT │  OR    │ hosted STT POST │──┼──segments─▶│ router: reviewRunner(orgId)/ /v1 gateway    │
 │  │ whisper   │(offline│  (opt-in)       │  │            │ Track: linkWorkItem(linkedMemoryIds)        │
 │  │ /ort)     │ default)└─────────────────┘ │◀─transcript│ worker/memory_jobs: deferred summary job    │
 │  └───────────┘                             │            │ connectors: gong/fireflies runtime (alt)    │
 │  renderer: live transcript + summary editor│            │ PostgreSQL (memory, track, jobs, tenancy)   │
 └───────────────────────────────────────────┘            └───────────────────────────────────────────┘
     capture+VAD local in BOTH modes                          summary = an org-resolved routed call
```

## Where Meetings lives (desktop primary, dashboard secondary)

Users interact with Meetings **mostly through the desktop app**, so the desktop is the primary
surface and the dashboard mirrors it.

- **Desktop — a fourth workspace mode.** Today the shell is `mode: 'chat' | 'track' | 'code'`
  (`brainrouter-desktop/src/App.tsx:121`, switched in `App/layout/MainContent.tsx`, toggled by the
  `.mode-seg` tabs in `components/layout/Sidebar.tsx:154`, carded on `components/chat/HomeView.tsx`).
  Meetings adds **`'meetings'`** as a peer mode: a left meetings list + a detail pane (live/loaded
  transcript, the generated summary, action items, and the **sharing scope control**). New-meeting
  entry points: **Record** (M2+, live capture), **Import audio** (M1), **Paste transcript** (M0). The
  same right-hand contextual panels (provenance, linked Track items) reuse the existing `ViewsRail`.
  *(Coordinates with Codex's shell redesign — spec §8.3 keeps Chat/Code/Track; Meetings is the new
  4th mode and its mode-tab + view branch are the only shell edits.)*
- **Dashboard — a `Meetings` nav item + `/meetings` route.** A list page (search, date, scope badge,
  attendees) and a detail page (summary, transcript, action-items → Track, and the scope control) —
  a new `brainrouter-dashboard/app/meetings/page.tsx` + one Sidebar nav entry, alongside
  Overview/Chat/Reviews.
- **The Model/Effort control** (Codex's server-managed selector) sits on the summary action, so a user
  picks which BrainRouter/BYOK model summarizes — consistent with Chat.
- **Sharing control (D8)** is one segmented control — **Private · Team · Org · Public** — with Public
  revealing a copyable link + revoke; it appears in both surfaces on the meeting detail.
- **Public read** is its own minimal unauthenticated page (`/m/:token` or `GET /api/public/meetings/:token`)
  showing the redacted summary only.

## Phased plan (cheapest-first; each verified locally; no commits until approved)

| Phase | Scope | Anchors | Verify |
|---|---|---|---|
| **M0 — Memory-native meeting + sharing, text only** *(highest leverage, ~no new infra; account-gated)* | `MeetingsService.recordMeetingSummary` (account-gated: requires `userId`+`orgId`); **pasted/imported transcript** → `ingestSource(kind:"transcript")` + summary `CognitiveRecord`s (`metadata.kind:"meeting"`) via `upsertEngineeringMemory`, linked via `linkRecordSources`; **D8 sharing model** (`private`/`team`/`org`/`public` — extend `MemoryVisibility`, `team_id`, `meeting_shares` token table + public read route); summarize via the `reviewRunner`-pattern runner; create Track action items | `engine.ts:661`; `memoryOps.ts:133,164`; `ingest.ts:23`; `knowledgeImport.ts:97`; `items.ts:226`; `records.ts:145`; `memorySharingQueries.ts:24` | recall a meeting; provenance → transcript spans; each scope enforces read access; public token serves redacted summary only; action items in Track |
| **M1 — Import audio → transcript (server STT)** | Port Meetily's `audio/import.rs` decode→resample→VAD→Whisper as a **server transcription job** (no live capture); feed output into M0 | Meetily `audio/import.rs`; `whisper_engine.rs`; `memory_jobs` worker | upload a file → transcript → summary memory |
| **M2 — Desktop capture sidecar (mic)** | Extract Meetily capture+VAD+STT into a Rust sidecar (`utilityProcess.fork`); add `setPermissionRequestHandler` + Info.plist + preload media channel; **local whisper** mode; live `transcript-update` to renderer | `main.ts:248`; `host.ts:37`; `preload.cts:7`; Meetily `pipeline.rs`/`vad.rs`/`stream.rs` | mic meeting → live local transcript |
| **M3 — System audio + mixing** | macOS CoreAudio `cidre` tap (no BlackHole) + Windows WASAPI loopback; additive-soft-clip mix | Meetily `capture/core_audio.rs`; `devices/platform/{macos,windows}.rs` | mic+system captured together |
| **M4 — Hosted STT default + streaming summary** | Sidecar POSTs VAD segments to the STT microservice (shared `whisper_engine.rs`, GPU image); server-default/local-override toggle; **streaming** summarization via router (drop Meetily's 5 s polling) | spec §7/§11; `modelRunner.ts:194` | hosted transcription; streamed summary; offline still works |
| **M5 — Connector ingestion + calendar (optional)** | Implement `gong`/`fireflies` connector runtimes via the memory bridge; scope a calendar/attendee-identity entity | `connector.ts:37`; `knowledgeImport.ts:61` | Gong/Fireflies transcript → meeting memory |

**M0 alone** delivers a recallable, Track-linked meeting summary with almost no new code — highest
leverage first. The two heavy slices are **M2/M3** (native capture sidecar) and **M4** (hosted STT
microservice). M1–M4 each stand alone and ship value independently.

## LLMRunner adjustment (after Codex's server-managed-models lands) — **blocking dependency**

BrainRouter now ships **its own hosted provider** (Codex is landing the desktop's built-in read-only
`BrainRouter` provider + `GET /api/models/catalog` in `brainrouter-desktop/electron/accountIntegration.ts`,
and the server-side `provider_models` + `/v1` gateway per the spec). Summarization must consume **that**
by default. So the summarizer's model resolution is **deliberately deferred**:

- **Now (M0):** summarize via the existing per-org runner pattern (`reviewRunner`-style job-local
  `ModelLLMRunner` with `resolveProviderConfig(store, orgId, "llm")`). This already routes server-side
  through the single `modelGateway.dispatch` chokepoint and is enough to prove the pipeline.
- **After Codex:** adjust `ModelLLMRunner`/the meeting summarizer to resolve the model from the
  **server-managed catalog** (`provider_models` / `/v1`), honoring the org's enabled models + allowed
  reasoning efforts, with the desktop's built-in `BrainRouter` provider as the default and BYOK as the
  override. This is the one piece that **must not be finalized until Codex's provider work merges** —
  wiring it earlier would fork the model-resolution path. M0 is written so this is a localized swap of
  the runner factory, not a rewrite (the `MeetingsService` takes the runner as an injected dependency).

## Alignment with the server-managed-models spec
- Summarization defaults to server-managed models (admin enables models + allowed efforts); desktop
  BYOK stays available — Meetings inherits this automatically by routing through the same runner.
- STT is a microservice with its own image/health/readiness and GPU build, added to Compose alongside
  API / model-gateway / worker / remote-relay / Postgres (spec §11) — no new externally hosted
  dependency; local mode preserves offline operation.
- **Lineage note:** the account-based device pairing shipped in #844 (reuses `active_sessions` + LAN
  relay) is the interim remote-desktop path; the spec §9 **account-authenticated outbound-WSS broker**
  (`remote-relay`, `remote_devices`/`grants`) is the target. Meetings does not depend on remote access,
  but a "monitor my meeting from my phone" feature would ride that broker, not the LAN relay.

## Security & privacy
- **Account-gated (D7):** no meeting is stored, summarized, or shared without a BrainRouter sign-in.
- Audio never leaves the device without explicit opt-in; hosted STT is consented + org-scoped.
- Every transcript/summary write goes through the redaction + 64 KB chokepoint (`memoryOps.ts:164`).
- **Sharing (D8):** `private`/`team`/`org` are backend visibility scopes with per-user IDOR-pinned
  recall and RBAC on promotion; **only the owner** can change a meeting's scope. `public` is the sole
  outward-facing path — a **deliberate, audited, revocable publish** that mints a random `meeting_shares`
  token and serves **only the redacted summary** (never raw transcript or audio) from a rate-limited,
  unauthenticated `GET /api/public/meetings/:token`; downgrading scope revokes the token immediately.
- No audio/prompt/response bodies in telemetry or logs (spec §14).

## Non-goals
- **Speaker diarization** (Meetily PRO territory) and **sub-300 ms live captioning** — segment-delayed
  captions only (Whisper is segment-based).
- **Porting `llm_client.rs`** — the router replaces it (D2).
- **A new `meetings`/`summary_processes` SQL schema** in the primary path — memory + `memory_jobs` +
  Track cover it (D1/D5). A thin index table is reconsidered only if listing performance demands it.
- **Per-provider API-key columns** — ADR-012 provider registry only (D5).
- **Calendar / first-class Person entity** — deferred to M5 (needs a new entity/connector).
- **Reintroducing Meetily's archived FastAPI backend** — it is unsupported legacy.

## Research corrections (so the plan is grounded, not on Meetily's stale docs)
- There is **no `transcribe-rs`** dependency; Parakeet is a bespoke `ort`/ONNX implementation and is
  **CPU-only as written** (`parakeet_engine/model.rs`) — server GPU needs a CUDA/CoreML/TensorRT EP.
- The mixer is a **plain additive sum with soft-clip**, not RMS ducking (the name + Meetily's CLAUDE.md
  are misleading); the mix window is **600 ms**, not 50 ms.
- Meetily's `meeting_notes` table is **unwired** (zero Rust references) — ignore it.
