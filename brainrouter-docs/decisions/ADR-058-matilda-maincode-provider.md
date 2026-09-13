# ADR-058 — Matilda (Maincode) as a provider

**Status:** IMPLEMENTED (0.4.22) — P1 (the built-in module + registration + the
moved goldens + the `mc_live_` prefix) and P2 (the desktop brand tile + dev-harness
catalog + core prefix parity) are shipped. Every surface derives the tile from
`BUILTIN_PROVIDERS` — CLI wizard, desktop Models gallery, dashboard `/catalog`, and
the server catalog route — verified in the desktop renderer (the tile, the branded
chip, and the Connect dialog with a prefilled endpoint + Fetch-models + catch-all
toggle all render). Live turns with a real key are verified on both the compat and the
native surface; **D13** adds the native `matilda-chat` adapter (tool calling via DSML),
mechanically complete and tested but — measured — preempted by Matilda's own
server-side search on most realistic agent prompts (§6). · **Builds on:** ADR-012 (providers are DB-only
records on the server), ADR-047 D1 (providers as data — the declarative entry and the
live `ProviderRegistry`), the opt-in native wire adapters (0.4.16 — Anthropic-Messages
and Gemini-generate over the default OpenAI shim), and ADR-041's product-wide
registry discipline. · **Informed by:** the Maincode Matilda client-SDK
documentation (`maincode.com/docs`, the `client-sdk-*` pages) plus unauthenticated
HTTP probes of the live host that confirmed the endpoint shape (§6), read for the wire
shape only — no vendor SDK is added; BrainRouter integrates at the HTTP level. ·
**Supersedes:** nothing.

**Date:** 2026-09-12

> Matilda is Maincode's hosted model service (base `https://matilda.maincode.com/api`,
> keys prefixed `mc_live_`). It exposes **two** wire surfaces: a **native
> Responses-like** API (`chat.create({input, conversationId})`, server-held
> conversation history, `response.outputText`) and an **OpenAI-compatible**
> chat-completions endpoint that honours the standard `response_format`
> `json_schema`. BrainRouter is stateless per turn — it always sends the full
> `messages[]` array and manages its own history — so the native surface is a poor
> fit and the OpenAI-compatible surface is a clean one. The decision: add Matilda
> as a **first-class built-in provider module** targeting the **OpenAI-compatible
> surface** (confirmed live at `https://matilda.maincode.com/api/v1`), authenticated
> with the **static `mc_live_` Bearer key**, with **models discovered live from
> `GET /api/v1/models`** (confirmed served) and no hardcoded catalog. That is a single
> `ProviderDefinition` literal plus one registry line — zero transport, routing, or
> gateway code — and it makes the branded tile selectable in the `/config` wizard,
> the Desktop model gallery, and the server `/catalog`. The native surface and
> user-token OAuth are explicitly deferred to a future ADR; neither buys a wire-level
> capability the OpenAI-compatible surface + static key does not already give us.

---

## 1. Where the code is today

- **A provider is a small declarative record, not behaviour.** Every built-in
  provider is a flat `ProviderDefinition` object literal
  (`packages/core/src/provider/providers/definition.ts`) — `id`, `label`, `hint`,
  `endpoint` (the OpenAI-compatible **base**, e.g. `…/v1`; the transport appends the
  path), `envKey`, `local`, `pickerVisible`, optional `capabilities`
  (`['chat'|'embedding'|'reranker']`, default `['chat']`), optional `defaultModels`,
  `requestFormat` (default `'chat-completions'`), and the reasoning-effort fields.
  The interface comment is explicit that a module must **not** own a model catalog
  or a tier ladder. Modules are siblings in an ordered array — there is no
  subclassing. `ZenMux`
  (`packages/core/src/provider/providers/zenmux/index.ts`) is the whole shape a
  branded cloud needs: a fixed `endpoint`, an `envKey`, `pickerVisible: true`,
  reasoning fields **undeclared** (inherit `DEFAULT_EFFORT_VALUE_MAP`), and **no**
  `defaultModels` (the live `/models` drives the picker).

- **Registering a module is one array entry — everything downstream is derived.**
  A module is imported into `BUILTIN_PROVIDERS`
  (`packages/core/src/provider/providers/index.ts`); `PROVIDER_REGISTRY =
  new ProviderRegistry(BUILTIN_PROVIDERS)` and builtin ids are authoritative
  (`providerRegistry.ts` — a session/extension/declarative entry cannot shadow a
  builtin). From that one entry: `PROVIDER_CATALOG` (`catalog.ts`) surfaces any
  `pickerVisible && label && hint && envKey` module to the `/config` wizard and the
  Desktop gallery; `backfillApiKeyFromEnv` (`config.ts`) auto-derives the
  `endpoint → envKey` env-import map **from `BUILTIN_PROVIDERS` only**; and
  `findProviderByEndpoint` resolves a config whose `endpoint` matches (normalised —
  lower-cased, trailing `/`, `/chat/completions`, `/v1` stripped) to that def, so a
  config pointed at the host picks up the def's effort map regardless of the stored
  provider id.

- **Auth and path are fixed in the transport, uniform across cloud providers.**
  `packages/core/src/agent/transport/llmTransport.ts` emits
  `headers['Authorization'] = ` `` `Bearer ${apiKey}` `` for every
  chat-completions/responses provider (L1130, L1390) and builds the request URL as
  `` `${endpoint}/chat/completions` `` (normalising a doubled suffix). The runtime
  key is always `config.apiKey` (env-backfilled once at load), never `def.envKey` at
  call time. A `Bearer mc_live_…` key therefore needs **no** new code.

- **The declarative path (ADR-047 D1) adds a provider as data — with limits.**
  `cli.customProviders` entries (`DeclarativeProviderEntry`, `configTypes.ts`) are
  validated and converted by `declarativeToDefinition` and registered into the same
  live `ProviderRegistry` (`declarative.ts`); a packaged starter set lives in
  `declarative-starter.ts`. But a declarative entry registers **only** into the live
  `PROVIDER_REGISTRY`, and `buildProviderCatalog` enumerates the **static**
  `BUILTIN_PROVIDERS` (plus extension-contributed providers and a user
  `~/.config/brainrouter/providers.json`) — never the registry's dynamic
  registrations — so a declarative entry never reaches `PROVIDER_CATALOG` and never
  appears in the picker; nor is it in `backfillApiKeyFromEnv`'s map (derived from
  `BUILTIN_PROVIDERS` only), so its `envKey`, e.g. `MATILDA_API_KEY`, is silently
  ignored and the key must be hand-placed in `llm.apiKey`. The schema also has no
  auth-scheme, custom-header, per-path, or OAuth field — auth is the hardcoded
  Bearer above.

- **Native wire formats are opt-in adapters over the shim.** The 0.4.16 work added
  `anthropic-messages` and `gemini-generate` as native formats
  (`nativeProviders.ts`, `nativeProviderStream.ts`), selected via
  `resolveRequestFormat` / `cli.providerRequestFormat`; the default stays the OpenAI
  shim. A provider's own `requestFormat: 'responses'` means **OpenAI's** Responses
  API (`buildResponsesPayload` emits an `input` items array; the reader expects
  `data.output[]`) — it is **not** Matilda's native shape.

- **Models come from the endpoint, never hardcoded.** Three provider-agnostic
  consumers each derive the `/models` URL by the same rule — strip a trailing
  `/chat/completions`, append `/models` — and fetch it with Bearer auth: CLI
  `fetchOpenAiCompatibleModels` (via `deriveModelsUrl`), Desktop `fetchEndpointModels`
  (its own inline regex), and the server's SSRF-guarded `probeModels` (via
  `resolveModelsUrl`, which strips a wider set of wire suffixes and applies an 8-second
  upstream-policy fetch). Results populate the picker and `LLMConfig.cachedModels`
  (the offline fallback; a live `/models` always wins). Reasoning capability is read preferentially from `/models`
  metadata (`inferModelReasoningCapabilities`), with name patterns
  (`provider/models/reasoning.ts`) only as a fallback.

- **The server stores providers as DB rows (ADR-012), keyed per org.** A provider is
  a `provider_configs` row with `baseUrl`, a sealed `api_key_ciphertext`
  (`secretBox`, needs `BRAINROUTER_SECRET_KEY`), a `wire_format`, and an allowlist of
  `models`. `chatRoutes`/`modelGateway` Bearer-thread the decrypted key onto the
  chat-completions URL. Adding a provider is an **admin dashboard** action (`POST
  /api/admin/providers`), not a schema change; org inheritance means an inheriting
  org creates its own row to override the deployment default.

- **Routing is registry-driven and always-on.** `resolve.ts` / `registry.ts` /
  `policy.ts` / `gateway.ts` and the `:3748` provider-gateway derive their behaviour
  from the registry; adding a provider changes none of them. Explicit and
  primary-chain picks keep `withFallbacks:false` semantics (the router never silently
  swaps a picked provider), and the gateway forwards a whitelisted set of OpenAI
  sampling params (`GATEWAY_PASSTHROUGH_PARAMS` — `response_format` is on it) unchanged
  while the model is replaced by the resolved route, messages are re-mapped, and tools
  are rebuilt — so a gateway client's `response_format` reaches the upstream unchanged.

- **Matilda's two surfaces (from the SDK docs).**
  **(A) Native Responses-like.** `chat.create({input, conversationId})` /
  `chat.stream(...)`; multi-turn is **server-side** — the client sends only the
  latest `input` plus a `conversationId`, the server holds the history; streaming
  emits `response.output_text.delta`, the final text is `response.outputText`;
  structured output via Zod (`createObject`/`streamObject`); client-side tools need
  the separate agent SDK.
  **(B) OpenAI-compatible.** The docs (structured-output page) and a live probe both
  place it at **`POST /api/v1/chat/completions`** — base
  `https://matilda.maincode.com/api/v1`, structurally identical to ZenMux's
  `…/api/v1`. It supports the standard `response_format` in both
  `{ type: 'json_schema', json_schema: { name, schema } }` (applied `strict: true`
  server-side) and `{ type: 'json_object' }`. `GET /api/v1/models` is served
  (auth-gated), so the model list is discoverable at runtime.
  Auth is a Bearer token: either a static `mc_live_` API key, or an OAuth user token
  (PKCE loopback / RFC 8628 device flow) with skew-aware auto-refresh. §6 records what
  the live probe and docs confirmed and the few details that remain vendor-gated.

---

## 2. Decisions

**D1 · Target the OpenAI-compatible surface (B), not the native Responses-like
surface (A).** Integrate Matilda exclusively through its OpenAI-compatible
chat-completions endpoint. BrainRouter is stateless per turn and always emits the
full `messages[]` array (`buildChatCompletionPayload`) while managing its own
context/history; surface A sends only the latest `input` plus a server-held
`conversationId` and returns `response.outputText` — there is no `conversationId`
channel anywhere in the request path, and adopting one is an architectural change,
not an adapter. Surface B reuses the default wire with zero adapter code, and
`response_format` `json_schema` is on the gateway passthrough allowlist so it reaches
the upstream unchanged.
*Acceptance: a turn routes to Matilda over `POST {base}/chat/completions` with a
standard `messages[]` body and no code outside the provider module.*

**D2 · A first-class built-in provider module — not declarative-only, not a native
adapter.** Add `packages/core/src/provider/providers/matilda/index.ts` as a
`ProviderDefinition` and register it in `BUILTIN_PROVIDERS`. The declarative path
(ADR-047 D1) can already reach Matilda today by data alone, but a declarative entry
is absent from `PROVIDER_CATALOG` (never in the picker) and from
`backfillApiKeyFromEnv` (its `envKey` is inert) — a shipped *"provider support"* ADR
needs the branded tile selectable in the wizard, Desktop, and server catalog and
needs env-key backfill, and both require the built-in path. The native-adapter path
(8+ edits across `llmTransport`/`nativeProviders`/`nativeProviderStream`/config) is
only warranted for surface A, which D1 rejects. `zenmux` is the template — a
picker-visible branded cloud on an `…/api/v1` base with reasoning fields undeclared
and no `defaultModels`, structurally identical to Matilda's confirmed endpoint.
*Acceptance: "Matilda (Maincode)" appears in the `/config` wizard and the Desktop
model gallery; `MATILDA_API_KEY` in the environment is backfilled onto the config.*

**D3 · Auth: the static `mc_live_` Bearer key only; defer OAuth.** Put the `mc_live_`
key in the single sealed `apiKey` slot. The transport already emits `Authorization:
Bearer ${apiKey}` on every surface, so the key drops in with no code change. The
provider subsystem has **no** token-refresh seam — `apiKey` is a static string, and
the connector OAuth stack (`ConnectorTokenSecret`, `oauthBroker` PKCE,
`resolveGithubAccountToken` single-flight refresh, the RFC 8628 route) is disjoint
from provider resolution. Wiring OAuth would be a new provider-resolution bridge for
zero wire-level gain.
*Acceptance: a turn authenticates to Matilda with `Authorization: Bearer mc_live_…`
and no new auth code is added.*

**D4 · Models from the live `GET /api/v1/models`; no hardcoded catalog.** Ship the
module with **no** `defaultModels`. `GET /api/v1/models` is **confirmed served**
(auth-gated), so the picker is driven live (`fetchOpenAiCompatibleModels` /
`fetchEndpointModels` / `probeModels`), matching Golden Rule 16 and the ZenMux/starter
convention — **no offline seed is required**. (Matilda is not open-source and does not
publish its model ids; they are runtime data by design, which is exactly why we do not
hardcode them.) The offline-seed path stays available only as a contingency if the
listing later regresses.
*Acceptance: selecting Matilda populates the model list from
`https://matilda.maincode.com/api/v1/models`; the module source contains no model
ids.*

**D5 · Omit `requestFormat` and the reasoning fields on the module.** Leave
`requestFormat` unset (defaults to `'chat-completions'`) and the reasoning fields
undeclared (inherit `DEFAULT_EFFORT_VALUE_MAP`), mirroring ZenMux. Reasoning
capability is best resolved at runtime from `/models` metadata; declaring a
conservative default avoids guessing an effort contract we cannot yet confirm, and
unknown ids are treated as capable (not clamped) by `modelFamily`. Add name patterns
to `reasoning.ts` (and its desktop mirror) later, only if `/models` is thin.

**D6 · Endpoint base confirmed: `https://matilda.maincode.com/api/v1`.** The transport
hard-appends `/chat/completions` and the model-listing derivation appends `/models` to
the configured base, so the base had to be settled exactly. It now is, from two
independent sources: the docs state the OpenAI-compatible endpoint is `POST
/api/v1/chat/completions`, and an unauthenticated probe returns **401 Unauthorized**
on `/api/v1/chat/completions` and `/api/v1/models` (route exists, auth-gated) while
returning **404 `Cannot …/api/…`** on the `/api/…` (no `/v1`) variants; bare `/v1/*`
is the web app (307 → `/login`). So `endpoint = 'https://matilda.maincode.com/api/v1'`
yields chat at `…/api/v1/chat/completions` and discovery at `…/api/v1/models` — both
verified to exist.

**D7 · Server parity via the existing ADR-012 DB-only path — no schema change.** No
migration and no provider-record change. Admins add Matilda per org through the
dashboard (the OpenAI-compatible tile, or the new branded tile) → `POST
/api/admin/providers` with `kind:'llm'`, `baseUrl`, the `mc_live_` `apiKey`, and a
model allowlist; the server seals the key (`secretBox`, requires
`BRAINROUTER_SECRET_KEY`). Optionally add a one-time `MATILDA_*` seed in
`resolveFromEnv` / `seed.ts` for deployment-default bootstrapping.
*Acceptance: an admin adds Matilda in the dashboard and a routed turn succeeds; the
key is stored only as ciphertext.*

**D8 · Register the `mc_live_` key prefix.** Add `{ "prefix": "mc_live_", "vendor":
"Maincode Matilda" }` to `brainrouter-cli/config/api-key-prefixes.json` `known[]`.
`validateApiKey` warns (does not block) on an unfamiliar prefix; registering it
silences the warning without changing behaviour.

**D9 · Move every enumerated-surface golden in the same commit (Golden Rule 17).**
A picker-visible built-in trips the CLI `wizard.test.ts` **exact sorted `deepEqual`**
of `PROVIDER_CATALOG` ids — a hard cross-workspace break — so `'matilda'` is inserted
there (between `'lmstudio'` and `'ollama'`) atomically, alongside the
`provider-catalog.test.ts` `NEW[]` row, the `env-fallback.test.ts` backfill case, and
any `inert-value-sweep.test.ts` ceiling the new export moves. Forgetting this breaks
CI in the CLI and other workspaces even though core compiles.

**D10 · Register prod as the built-in; reach staging via a config endpoint
override.** The module carries the prod base only. `findProviderByEndpoint` keys on
the exact normalised host, so staging (`https://staging.matilda.maincode.com/api/v1`)
is reached by a user/admin setting `endpoint` on their config — the sanctioned
per-deployment path — not a second built-in that would bloat the catalog.

**D11 · Recommend `passthroughUnknown: true` on the Matilda config until a catalog
exists.** `resolve.ts` offers ids in no catalog to passthrough providers first, so a
hand-typed Matilda model routes immediately before a live `/models` catalog is
populated. This is a config recommendation, not code; the router stays always-on and
explicit-pick `withFallbacks:false` semantics are unaffected.

**D12 · Providers declare request limits; the transport shapes the request to fit.**
The first live agent turn against Matilda surfaced hard per-request limits its
endpoint enforces (§6, measured to the byte): a **64 KiB request body** (65 536 bytes
→ 200, 65 537 → `403 {"error":"forbidden"}`, checked at the edge *before* validation
— so an oversized turn only ever looked like an auth failure), **16 000 characters of
`content` per message** for every role (16 001 → 400), and **strict body validation**
that rejects `reasoning_effort` / `reasoning` (400). A BrainRouter agent turn is
~120 KB — a ~22k-char system prompt plus ~104 tool definitions — so a chat model
cannot receive it as-is. Rather than special-case one vendor in the transport, the
`ProviderDefinition` gains an optional **`limits: { maxBodyBytes, maxMessageChars }`**
and **one shared shaper** (`provider/requestLimits.ts`) honours it on *every* path that
fronts a provider — the desktop/CLI transport's `buildChatCompletionPayload` **and** the
server gateway's `buildUpstreamChatPayload` (which previously forwarded the client's
full turn verbatim, so the same 403 surfaced there as a 502 "authentication" error
while the direct path already worked) — for any provider that declares it:
each message's content is cut from the *tail* (instructions are front-loaded) to
`maxMessageChars` with a visible marker, and the tool list — the only elastic part
once messages are capped — is fitted to `maxBodyBytes` by **task relevance** (the same
`rankAndCapTools` ranking the MCP tool budget uses), binary-searching the largest
relevance-ranked subset that fits, measured in **UTF-8 wire bytes** (the agent
prompt's em-dashes and ellipses are 3 bytes each; a character count sits "under" the
budget while the request is over it). Matilda declares `{ maxBodyBytes: 65_536,
maxMessageChars: 16_000 }` and `reasoningEffort: 'unsupported'`. Providers that
declare no limits are byte-for-byte unaffected, and the gateway never re-adds an
effort field a provider's definition marks `unsupported`. *Acceptance: a real agent
turn (~120 KB, ~104 tools) shapes to ≤ 65 536 bytes with the task-relevant tools kept
and Matilda returns 200 on **both** the direct and the gateway path; an end-to-end
CLI turn completes.*

**D13 · The native `matilda-chat` adapter — because tool calling lives only there.**
The first keyed agent turn showed that Matilda's OpenAI-compatible surface **ignores
`tools` entirely** (it accepts the field and never emits `tool_calls`; a forced
`tool_choice` is ignored and the model answers from its own knowledge; the legacy
`functions` form is a 400). Tool calling exists only on the **native** surface
(`POST …/api/chat`, SSE), where the server templates `clientTools` for the model and
the model answers with a **DSML block in the text stream** — so D1's "compat only"
scope is amended: the module's default wire becomes `'matilda-chat'` (the compat
surface stays one override away, `cli.providerRequestFormat.matilda =
'chat-completions'`). Everything in the adapter is what the live endpoint measured,
not what the docs implied: the body is `{ messages, clientTools?, conversation_id,
responseMode:'auto' }` (`input` is an SDK convenience → 400; `role:'system'` → 400;
`role:'assistant'` history **is** accepted); the server **never** restores context
from `conversation_id` (with or without `persist`), so the full user+assistant history
travels every turn exactly like the OpenAI path and BrainRouter stays stateless
(`conversation_id` is a per-session grouping key, `sessionKey` threaded through
`BuildPayloadOptions`); instructions **prefixed onto the task message suppress**
client-tool calls (0/3 at every length, neutral or real text) while the same
instructions as their **own prior user message ending with an explicit client-tools
hint** restore them (3/3 with BrainRouter's real prompt) — so the system prompt is
sent as `messages[0]` + the hint and the task stays its own clean message;
`responseMode:'auto'` is required (omitted/`deep`/`instant` → 0/3) and the SDK's
"code specialist" routing text is deliberately not sent (it suppresses client tools);
two DSML dialects are parsed (the SDK's JSON `{name, arguments, id}` and the
parameter form the live model actually emits), lifted out of the visible text with a
token-boundary-safe interceptor, de-duplicated against the server's
`client_tool_call` event; tool results go back as `[Client tool result: <name>]`
user messages (the SDK's roundtrip shape); native limits are honoured — 64 KiB body
(403), ≤ 64 `clientTools` (400), ≤ 2 000 chars per tool description (400), ~20k
chars per message (422) — with tools fitted by task relevance. Implemented in
`provider/providers/matilda/{dsml,nativeChat}.ts` and wired through the existing
native-adapter seams (`NativeRequestFormat`, `nativeRequestSpec`, the transport's
stream/non-stream dispatch — the non-stream path consumes the same SSE).
*Acceptance (mechanical, met): the adapter builds a valid native body from a real
agent turn, the stream parser lifts DSML into `toolCalls`, a tool-result roundtrip
completes, and a live `brainrouter run` completes against the native surface.*
*Acceptance (behavioural, NOT met today — see §6): the model reliably calls the
advertised client tool on realistic agent prompts.*

**D14 · Runtime-mandated tools survive the byte fit.** The first attended agent
turns on the native adapter produced a model that said "no such tool exists" for
`profile_stage` — and it was right: both fits (D12's chat-completions shaper and
D13's native body) rank tools by token overlap with the latest user text, the
16k-char system prompt plus history had left room for nine tools, and
`profile_stage` — which the workspace strategy then demanded at turn end — shares no
token with "what do you think about the current state of Australia's economy".
Both shapers now pin ahead of relevance the tools a runtime guardrail names by name
(`RUNTIME_MANDATED_TOOLS` in `tool/policy/toolBudget.ts`: `profile_stage`,
`task_agent`, `update_plan`, `goal_complete`, `goal_blocked`) plus any tool the
latest user message names verbatim as a whole word (a guard correction reading
"Call task_agent with …"). The gateway inherits it through the shared shaper.
Recorded with it: the "evidence pack about guardrails in agent SDKs" the model
reported in the same turn is **Matilda's server-side `search`** having run on
BrainRouter's own guard correction ("Runtime profile-stage guardrail tripped…") —
the platform searches the latest user message, whatever it is — and is not a
BrainRouter feature nor switchable (§6); it fired only because the guard fired,
which D14 removes for the mandated-tool case.

---

## 3. What this is not

- **Not Matilda's native Responses-like surface.** No `conversationId` channel, no
  server-side history, no `chat.createObject`/`streamObject`, no client-tools agent
  SDK. That surface conflicts with stateless routing and BrainRouter's own history
  management; it is a future ADR (Phase 4), not this one.
- **Not a new native wire adapter.** No `matilda-responses` literal in
  `llmTransport`/`nativeProviders`/`nativeProviderStream`/config. Surface B is
  plain chat-completions on the existing shim.
- **Not OAuth / user tokens.** No PKCE, no device flow, no refresh lifecycle — the
  static `mc_live_` key only. The reuse seams are named in Phase 4 for the day it is
  required.
- **Not a hardcoded model list.** No curated catalog in the module; the endpoint's
  `/models` is the source of truth, with an offline seed only as a documented
  fallback.
- **Not a server schema change.** No migration; Matilda is a `provider_configs` row
  like every other cloud LLM under ADR-012.
- **Not a routing or gateway change.** The add is registry-driven; `resolve`/
  `policy`/`recovery`/`gateway` and the `:3748` service are untouched.

---

## 4. Dependency-ordered delivery board

Each row is one pull request; P1 rows are one small PR, P4 is a separate future ADR.
P0 is **done** (see §6) — it is kept here as the record of what was verified.

- **P0 — Confirm the live API (DONE, §6).** ✅ Endpoint base
  `https://matilda.maincode.com/api/v1` (docs + probe); ✅ `GET /api/v1/models` served;
  ✅ `Authorization: Bearer <key>` gate; ✅ `response_format` `json_schema` (strict) +
  `json_object`; ✅ staging base documented. Standard chat-completions SSE follows
  from the compatibility contract; a valid `mc_live_` key on the compat surface,
  compat-surface tool-calling, published rate limits, and `/models` reasoning metadata
  are account-gated / unpublished and confirmed on first keyed use — none blocks P1.
- **P1 — Core built-in module (DONE).** ✅ `providers/matilda/index.ts` (`endpoint:
  'https://matilda.maincode.com/api/v1'`, chat-completions default, reasoning omitted,
  no `defaultModels`, `envKey: 'MATILDA_API_KEY'`, D2/D4/D5), registered in
  `BUILTIN_PROVIDERS`, `mc_live_` prefix added (D8), and the enumerated goldens moved
  in the same commit (D9: CLI `wizard.test.ts`, core `provider-catalog.test.ts`,
  `env-fallback.test.ts` — all green). A `config/models.json` context-window row and a
  `providers.json` tier ladder stay optional follow-ups once real ids surface from the
  live `/models`.
- **P2 — Selectability + discovery across surfaces (DONE).** ✅ Verified in the desktop
  renderer: the "Matilda (Maincode)" tile appears in the Models gallery and its Connect
  dialog prefills the endpoint, offers Fetch-models, and the catch-all toggle (D11);
  the CLI wizard, dashboard `/catalog`, and server catalog route all derive the same
  tile from `BUILTIN_PROVIDERS`. Added a green brand chip (`ProviderIcon.tsx`) and the
  dev-harness catalog fixture. `modelFamily.ts`/`reasoning.ts` name patterns stay
  optional, only if a thin `/models` needs them.
- **P3 — Server per-org parity (ADR-012) (no code change).** No migration; the server
  catalog route already derives from `BUILTIN_PROVIDERS`, and the dashboard add flow
  seals the `mc_live_` key (needs `BRAINROUTER_SECRET_KEY`) over the generic
  chat-completions path. A `MATILDA_*` env seed in `resolveFromEnv`/`seed.ts` stays an
  optional deployment-bootstrap follow-up.
- **P4 — Native surface A (DONE as D13); OAuth still deferred.** ✅ The
  `matilda-chat` adapter (`provider/providers/matilda/{dsml,nativeChat}.ts`, wired
  through `NativeRequestFormat` / `nativeRequestSpec` / the transport's native
  dispatch, `sessionKey` on `BuildPayloadOptions`, the format literal in every
  union/allowlist and the CLI wire-format golden) — built because tool calling exists
  only there; mechanically verified live, behaviourally preempted by the platform
  (§6). User-token OAuth remains out of scope until required.

---

## 5. How this will be judged

1. Selecting **"Matilda (Maincode)"** in the `/config` wizard (and the Desktop model
   gallery), pasting an `mc_live_` key, and fetching models yields a populated model
   list from the live endpoint — with **no** model ids written into the codebase.
2. A chat turn routes to `matilda/<model>` (and a bare `<model>` fans out to it),
   authenticates with `Authorization: Bearer mc_live_…`, and completes — with **no**
   change to `llmTransport`'s wire path, the router, or the gateway.
3. `MATILDA_API_KEY` present in the environment is backfilled onto the config exactly
   as any other built-in cloud key.
4. An admin adds Matilda for their org in the dashboard; the key is stored only as
   sealed ciphertext, and a routed turn through the server gateway succeeds.
5. CI is green **across every workspace** on the same commit — the CLI
   `wizard.test.ts` sorted catalog, `provider-catalog`, and env-fallback goldens all
   include `matilda`.
6. The `mc_live_` prefix no longer produces the wizard's "unfamiliar prefix" warning.

---

## 6. What the live API confirmed

Every question that gated the design has been answered — from the Maincode docs and
from unauthenticated HTTP probes of the live host (a probe distinguishes a real but
auth-gated route, **401**, from a wrong path, **404**). The handful that genuinely
require a valid `mc_live_` key are isolated below and none blocks P1.

**Confirmed — the design rests on these:**

1. **Endpoint base — `https://matilda.maincode.com/api/v1`.** The structured-output
   doc names the OpenAI-compatible endpoint `POST /api/v1/chat/completions`; the probe
   agrees: `/api/v1/chat/completions` and `/api/v1/models` return **401
   `{"error":"Unauthorized"}`** (exist, auth-gated) while `/api/chat/completions` and
   `/api/models` return **404 `{"error":"Cannot …/api/…"}`**. (Bare `/v1/*` is the web
   app: **307 → `/login`**.)
2. **`GET /api/v1/models` is served** (401 unauth → exists). Models are discovered
   live; **no offline seed is needed** (D4). The exact JSON rows are read at runtime.
3. **Auth is `Authorization: Bearer <key>`.** A `Bearer` request reaches the auth
   check and returns 401 *invalid-key* (not a 400 malformed-header), confirming the
   scheme. `mc_live_` keys drop into BrainRouter's existing uniform Bearer header.
4. **Structured output** — `response_format` is supported as
   `{ type: 'json_schema', json_schema: { name, schema } }` (applied **`strict: true`
   server-side** — "the `strict` and `name` fields you supply are re-wrapped
   downstream") and `{ type: 'json_object' }`. (Note: the agent's own
   `buildChatCompletionPayload` never synthesises `response_format` — it uses forced
   `tool_choice`; strict `json_schema` flows end-to-end only on the gateway passthrough
   path.)
5. **Staging base is `https://staging.matilda.maincode.com/api`** (docs); its compat
   surface is `…/api/v1` by the same shape, reached via a config `endpoint` override
   (D10), not a second built-in. (The staging host did not resolve publicly at probe
   time — expected for a non-prod environment.)
6. **Streaming** — the endpoint is OpenAI-compatible, so `stream:true` yields the
   standard chat-completions SSE (`data:` chunks with `choices[].delta`, terminated by
   `[DONE]`) that BrainRouter's stream parser already consumes. (Matilda's
   `response.output_text.delta` events belong to the *native* surface (A), not this
   one.)

**Measured on first keyed use — hard request limits (these drove D12):**

- **64 KiB request body.** With a real key, 65 536 bytes → 200 and 65 537 → `403
  {"error":"forbidden"}`; the check is at the edge, *before* any validation, so an
  oversized request never reaches the per-field validator. This — not auth, routing,
  or tool count — was the 403 a full BrainRouter agent turn (~120 KB) produced. It is
  a limit on **UTF-8 wire bytes**: a body of 65 469 JS characters was 65 752 bytes and
  was refused.
- **16 000 characters of `content` per message**, every role (a 16 001-char user
  message → 400 "must be shorter than or equal to 16000"); characters, not bytes
  (16 000 em-dashes, 48 KB, passed).
- **Strict body validation** — any unexpected property is a 400 ("property
  reasoning_effort should not exist", likewise `reasoning`).
- **Tool calling on the compat surface does not exist** — `tools`/`tool_choice` are
  accepted on the wire (200) but **ignored**: no `tool_calls` are ever emitted, a forced
  `tool_choice` is ignored (the model answers from its own knowledge), and the legacy
  `functions` form is a 400. Streaming, sampling params and `max_tokens` are honoured.
  Tool calling lives only on the native surface (D13).

**Vendor-gated / unpublished — confirmed on first keyed use, non-blocking:**

7. **A valid `mc_live_` key on the compat surface.** The route clearly does Bearer
   auth; that a *live-key* (vs an OAuth user token) is accepted there is confirmed the
   moment a real key is pasted — the same first-use check every provider gets. No code
   depends on the answer.
8. **Tool/function-calling** — resolved with a key: absent on the compat surface,
   present on the native surface as DSML (D13), and subject to the platform behaviour
   measured below.
9. **Rate limits** (RPM/TPM, concurrency) are not published and are absent from
   response headers; the API-platform page states limits are **"lifted per account
   while the API is in early access,"** so there is no fixed ceiling to encode now.
   `RouterPolicy` treats 429s as retryable and cools the route down — reactive handling
   needs no published numbers.
10. **`/models` reasoning metadata** (`capabilities` / `supported_parameters` /
    `supported_reasoning_efforts` vs bare `{id}`) is read at runtime; D5's conservative
    default stands regardless, with name patterns added later only if the listing is
    thin.

**Measured on the native surface (D13) — how reliably the model calls a client tool:**

- The mechanics work end to end: a real agent turn builds a valid 64 KB native body
  (38 fitted tools, `read_file` first), the stream parses, DSML calls are lifted, a
  tool-result roundtrip completes, and `brainrouter run` returns an answer in ~22 s.
- **Matilda's own server-side tools preempt client tools.** On a realistic task
  ("Read the file notes.txt in this workspace… use your file-reading tool"), the
  platform's orchestrator runs its **web `search` before the model answers** on 25 of 26
  calls — across 38/8/1 tools, 16k/4k instructions, a stronger hint, `responseMode`
  `auto`/`instant`/`deep`, a framing line on the task, and the explicit tool-naming
  phrasing that had scored 3/3 in isolation — and the model then treats those results as
  user-provided context, asks where the file is, or claims it lacks the tool. Even the
  bare single-tool task was only ~2/3.
- **There is no way to disable the server-side tools**: the SDK exposes no option and
  every plausible request flag (`serverTools`, `tools`, `disableSearch`, `webSearch`,
  `toolPolicy`, `agentMode`, …) is rejected by the strict validator as an unknown
  property.
- **Consequence:** the adapter is the right integration and is kept as the default
  wire, but Matilda cannot drive BrainRouter's autonomous tool loop *today* — it is a
  strong chat/knowledge model whose client-tool calling is preempted by its own
  platform. That is a Maincode-side behaviour to raise with them (a per-request switch
  to disable server tools, or honouring advertised client tools ahead of platform
  search). Until then, route tool-heavy work to another provider.
