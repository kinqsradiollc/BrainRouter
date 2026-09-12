# ADR-058 — Matilda (Maincode) as a provider

**Status:** PROPOSED · **Builds on:** ADR-012 (providers are DB-only records on the
server), ADR-047 D1 (providers as data — the declarative entry and the live
`ProviderRegistry`), the opt-in native wire adapters (0.4.16 — Anthropic-Messages
and Gemini-generate over the default OpenAI shim), and ADR-041's product-wide
registry discipline. · **Informed by:** the Maincode Matilda client-SDK
documentation (`maincode.com/docs`, the `client-sdk-*` pages), read for the wire
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
> surface**, authenticated with the **static `mc_live_` Bearer key**, with **models
> discovered live from `/models`** and no hardcoded catalog. That is a single
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
  **(B) OpenAI-compatible.** A chat-completions-shaped endpoint that supports the
  standard `response_format` `{ type: 'json_schema', json_schema: { name, schema },
  strict: true }`.
  Auth is a Bearer token: either a static `mc_live_` API key, or an OAuth user token
  (PKCE loopback / RFC 8628 device flow) with skew-aware auto-refresh. The exact
  OpenAI-compatible **path** (`…/api/chat/completions` vs `…/api/v1/chat/completions`),
  the model ids, and whether that endpoint lists `GET /models` are **not** in the
  public docs — they live behind the live account (see Open questions).

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
only warranted for surface A, which D1 rejects. `zenmux` is the template.
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

**D4 · Models from the live `GET /models`; no hardcoded catalog.** Ship the module
with **no** `defaultModels`. The picker is driven live (`fetchOpenAiCompatibleModels`
/ `fetchEndpointModels` / `modelProbe`), matching Golden Rule 16 and the ZenMux/
starter convention. Seed a minimal `defaultModels` (or `config.models[]` /
`cachedModels`) offline fallback **only if** Phase 0 finds the compat endpoint serves
no listable `/models`, and only once real ids are confirmed.
*Acceptance: selecting Matilda populates the model list from `{base}/models`; the
module source contains no model ids.*

**D5 · Omit `requestFormat` and the reasoning fields on the module.** Leave
`requestFormat` unset (defaults to `'chat-completions'`) and the reasoning fields
undeclared (inherit `DEFAULT_EFFORT_VALUE_MAP`), mirroring ZenMux. Reasoning
capability is best resolved at runtime from `/models` metadata; declaring a
conservative default avoids guessing an effort contract we cannot yet confirm, and
unknown ids are treated as capable (not clamped) by `modelFamily`. Add name patterns
to `reasoning.ts` (and its desktop mirror) later, only if `/models` is thin.

**D6 · Confirm the endpoint base path before wiring (a hard prerequisite).** The
transport hard-appends `/chat/completions` and `deriveModelsUrl` appends `/models` to
the configured base, so a wrong base breaks **both** chat and discovery with no
visible error. If Matilda serves chat at `…/api/v1/chat/completions`, `endpoint` must
be `https://matilda.maincode.com/api/v1`; if at `…/api/chat/completions`, use
`https://matilda.maincode.com/api`. This is settled in Phase 0, not as a follow-up.

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
the exact normalised host, so `staging.matilda.maincode.com/api` is reached by a
user/admin setting `endpoint` on their config — the sanctioned per-deployment path —
not a second built-in that would bloat the catalog.

**D11 · Recommend `passthroughUnknown: true` on the Matilda config until a catalog
exists.** `resolve.ts` offers ids in no catalog to passthrough providers first, so a
hand-typed Matilda model routes immediately before a live `/models` catalog is
populated. This is a config recommendation, not code; the router stays always-on and
explicit-pick `withFallbacks:false` semantics are unaffected.

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

Each row is one pull request; P0 gates everything, P1 rows are one small PR, P4 is a
separate future ADR.

- **P0 — Confirm the live API (blocking).** Settle D6 (the chat path, so the
  `endpoint` base) and whether `{base}/models` is served and its JSON shape; confirm
  the `mc_live_` key is accepted on the compat endpoint and the header is literally
  `Authorization: Bearer <key>`; confirm SSE uses the standard `choices[].delta`
  chunk shape and whether tool-calling and strict `json_schema` `response_format` are
  supported; record concrete model ids and any rate limits.
- **P1 — Core built-in module.** `providers/matilda/index.ts` (chat-completions
  default, reasoning omitted, no `defaultModels`, `envKey: 'MATILDA_API_KEY'`, D2/
  D4/D5); register in `BUILTIN_PROVIDERS`; add the `mc_live_` prefix (D8); move the
  enumerated goldens in the same commit (D9). Conditionally seed
  `config/models.json` context windows and a `providers.json` tier ladder once ids
  are known.
- **P2 — Desktop/CLI selectability + discovery.** Regression-check the tile in the
  Desktop gallery and CLI wizard and that `/models` populates the allowlist (no code
  expected); optionally add a brand-icon rule in `modelFamily.ts` and reasoning name
  patterns (`reasoning.ts` + the desktop mirror) only if `/models` is thin.
- **P3 — Server per-org parity (ADR-012).** No migration; confirm the dashboard add
  flow seals the `mc_live_` key (needs `BRAINROUTER_SECRET_KEY`); optionally add a
  `MATILDA_*` env seed; update `chatRoutes`/`modelGateway`/`seed`/`inherit` and the
  `provider-router(-gateway)` routing tests.
- **P4 — DEFERRED (future ADR): native surface A + OAuth.** Only if server-side
  conversation state, native validated-object output, or user-token auth becomes a
  hard requirement — the adapter files and the OAuth reuse seams are enumerated in
  §5 of the research so the future ADR starts from a map, not a blank page.

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

## 6. Open questions (resolve in P0, against the live account)

1. **Endpoint base path** — is the OpenAI-compatible chat surface at
   `…/api/chat/completions` or `…/api/v1/chat/completions`? (Sets `endpoint` and the
   derived `/models` URL — D6, blocking.)
2. **`GET /models`** — does the compat endpoint serve a listable models route, and
   what is its JSON shape (`{data:[{id}]}`)? If absent, an offline `defaultModels`
   seed is required (D4).
3. **Model ids** — the concrete ids on the compat surface, for the offline seed,
   context-window table, and reasoning classification.
4. **Key acceptance** — is the `mc_live_` static key accepted on the OpenAI-compatible
   endpoint, or is that surface OAuth-user-token only? Can one credential call both
   surfaces?
5. **Auth header** — confirm it is exactly `Authorization: Bearer <key>`.
6. **Streaming + tools** — does the compat surface stream the standard
   `choices[].delta` chunk shape, and does it accept tool/function-calling params?
7. **Structured output** — is `response_format` `{ type: 'json_schema', strict: true }`
   truly enforced server-side, and what is the error behaviour on a schema violation?
   (Note: the agent's own `buildChatCompletionPayload` never synthesises
   `response_format` — it uses forced `tool_choice`; strict `json_schema` only flows
   end-to-end on the gateway passthrough path.)
8. **Rate limits** — RPM/TPM, concurrency, burst — for cooldown/quota awareness
   (`RouterPolicy` treats 429s as retryable but has no proactive quota model).
9. **Reasoning metadata** — do `/models` rows advertise
   `capabilities`/`supported_parameters`/`supported_reasoning_efforts`, or only
   `{id}`? (Governs whether name patterns are needed.)
10. **Staging vs prod** — confirm both accept the same key shape; staging is reached
    via a config `endpoint` override (D10), not a second built-in.
