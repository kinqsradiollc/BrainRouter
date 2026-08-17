# ADR-043 — Egress at the user's edge: per-user provider IPs without the credential ever leaving the server

**Status:** Accepted — S1 implemented (2026-08-17, `release/0.4.21`); S2–S5 gated on ADR-041. **S1 (D5): the gateway rate-shaper** — per-upstream-key concurrency + rpm token-bucket + Retry-After backoff + bounded fair-share queue (`services/gateway/rateShaper.ts`, keyed for per-org sharding), wired into `chatRoutes` fail-open: an upstream 429's Retry-After parks the key so a burst stops hammering a provider that already refused (the review-bot free-tier wedge), and requests to a parked key fast-fail with the hint. The concurrency/rpm queue primitive is built + tested and ready to enable (S1b). **S2 (ProviderDialer seam), S3 (tunnel over the relay), S4 (consent/telemetry/fallback), S5 (vendable-token path) depend on ADR-041's `EdgeDialer`/ProviderDefinition seams** and are deferred until 041 lands.

**Builds on:** the provider gateway (`brainrouter/src/services/gateway/`), the remote-relay WSS edge
(`brainrouter/src/services/remoteRelay/`), org BYOK, ADR-041 (capability seams / execution worlds).

**Date:** 2026-08-16

---

## 0. The decision in one page

Managed models put the provider credential on the BrainRouter server, so **every** managed-model
request from **every** user egresses from the server's IP addresses. Providers rate-limit by IP (and
separately by key and by account); one busy tenant can therefore exhaust the IP budget for the whole
install, and scaling users makes it strictly worse. The obvious fix — do the provider call on the
client — collides with the gateway's founding rule: *"Upstream credentials never cross it"*
(`brainrouter/src/services/gateway/server.ts:1`). Handing the shared key to clients is a leak, full
stop.

These two goals are not actually in conflict, because **who holds the key** and **whose IP the
provider sees** are separable:

> **Keep the credential and the TLS session on the server; route the encrypted bytes through the
> requesting user's own device. The server dials the provider *through* a client-side tunnel, so the
> provider sees the user's IP while the client sees only ciphertext it cannot read — the same
> opaque-frame-splicing trust model the remote relay already ships. Where a provider offers
> short-lived vended tokens, prefer those; where the client is absent, fall back to server egress
> behind an explicit rate-shaping layer. BYOK remains fully client-side and untouched.
> Because not every provider limits by IP, egress is a **per-provider setting chosen where the
> provider is configured** — default plain server egress; the tunnel is switched on only for the
> providers where IP limits actually bite. And the tunnel is built as a **fabric, not a
> provider feature**: connectors, agent web research, local models behind the user's NAT, and
> firewalled enterprise services are further consumers of the same relay under the same rules
> (§8).**

One privacy rule makes the design safe to state in one line: **a user's device only ever carries
that user's own traffic.** The tunnel exists to give the provider a truthful per-user address, not
to build a proxy pool out of customers.

---

## 1. Where the code is today

| Piece | Current shape | Consequence |
|---|---|---|
| Provider gateway | `brainrouter/src/services/gateway/server.ts` — hosted OpenAI-compatible data plane (`:3748 /v1`); header says credentials never cross the boundary; org/tenant auth via `GatewayAuthContext` | Correct trust model, wrong egress topology: all upstream calls leave from the server host. N tenants share one (or few) source IPs against per-IP provider limits. |
| Managed-model transport | Server-side `llmTransport` performs the upstream HTTPS call with the stored key | The key never leaves the server (good); the egress IP is always the server's (the problem). |
| BYOK | Org-scoped keys; sub-agents use org BYOK; clients holding their own key call providers directly | Already per-user egress — proof that per-user IPs solve the limit in practice. Does not help managed models, which exist precisely for users without keys. |
| Remote relay | `brainrouter/src/services/remoteRelay/server.ts` — WSS edge; single-use tickets presented in the first frame; splices **opaque frames it cannot decrypt**; bounded frame size (128 KiB), queues (4 MiB), rate (200 fps); fail-closed | The exact primitive a credential-blind tunnel needs — ticketing, splicing, bounding — already written, reviewed, and shipped for device pairing. |
| Rate-limit handling | Gateway/LLM retry hardened with jitter + `Retry-After` honoring | Retries smooth spikes but cannot manufacture address diversity; under a per-IP cap they only spread the same starvation over time. |

### 1.1 The rate-limit taxonomy (what we are actually fighting)

Provider limits bind at three different scopes, and each needs a different mitigation — an ADR that
conflates them fixes nothing:

- **Per-IP** — anti-abuse throttles at the provider's edge (CDN/WAF tiers, free tiers). *Only
  address diversity helps.* This is the scope this ADR's tunnel targets.
- **Per-key** — requests/tokens per minute attached to the credential itself. Address diversity is
  useless; only more keys, queueing, or paid tiers help.
- **Per-account/org** — aggregate caps above keys. Same as per-key, from the provider's console.

---

## 2. Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Ship the managed key to the client | **Rejected** | Any client-visible key is extractable (memory dump, proxy, patched binary). A shared managed key on one hostile client is a credential breach for every tenant. Violates the gateway's stated boundary. |
| B. Provider-vended short-lived tokens | **Adopted where offered** (D3) | Some providers can mint scoped, expiring session tokens server-side; the client then calls the provider directly with a token that is worthless in hours and scoped to one session. Correct by construction — but not offered by most chat-completion APIs today, so it cannot be *the* mechanism. |
| C. Server-side egress pool (multi-region IPs / proxies) | **Rejected as primary; kept as operator option** (D5) | Costs scale with tenants, providers actively fingerprint datacenter proxy ranges, and shared pool IPs reproduce the same collision one hop away. As an operator-supplied knob for the server-egress fallback it is legitimate. |
| D. Per-org managed keys (key sharding) | **Complementary, not sufficient** | Splits the per-key scope, does nothing for per-IP (all keys still egress from one address). Worth doing for tenant blast-radius isolation regardless. |
| E. **Client-tunneled egress** — server-held key, server-terminated TLS, client-relayed bytes | **Adopted as the core** (D1/D2) | Separates key custody from address attribution. The client contributes exactly one thing it uniquely owns — its network address — and sees nothing it could not already see about its own traffic. |
| F. Gateway rate-shaping (queue + fair-share + `Retry-After` discipline) | **Adopted as the floor** (D5) | Whatever the egress path, per-key/per-account scopes still bind; without an explicit shaper the failure mode is today's wedge (a free-tier upstream stalling a required check). |

---

## 3. Decisions

### D1 — Inverted egress: the server dials the provider through the user's device

For a managed-model call from a connected client (desktop, CLI, mobile via relay):

1. The gateway resolves the credential and builds the upstream request exactly as today.
2. Instead of opening a socket from the server host, it requests an **egress tunnel** from the
   calling client: an instruction naming the provider endpoint (`host:port`) drawn from a
   server-side allowlist of known provider hosts.
3. The client opens a plain TCP connection to that host and splices bytes between it and the server
   over the existing WSS channel — opaque frames, same bounding discipline as the remote relay.
4. The **server** performs the TLS handshake *through* the tunnel, verifies the provider's
   certificate chain against system roots (plus optional per-provider pinning), then sends the
   request with the credential inside the encrypted stream.

Properties, stated as invariants:

- **The credential never crosses the boundary** — it travels only inside a TLS session terminated
  on the server. The client relays ciphertext.
- **The client cannot read or forge traffic.** Reading requires the TLS session keys (server-side
  only); impersonating the provider requires the provider's private key. A client that tampers
  with bytes breaks the TLS record MAC and the request fails closed.
- **The provider sees the user's IP** — the truthful address of the human whose request it is,
  which is exactly what per-IP limits are designed to meter.
- **A client can only hurt itself.** Dropping, delaying, or garbling the tunnel fails that user's
  own request; no other tenant's traffic is present (D2).

### D2 — The one-user rule and consent

- **Attribution honesty:** a device tunnels **only requests originating from its own authenticated
  session/org identity**. BrainRouter never routes tenant A through tenant B's address. This is a
  hard invariant, not a policy knob — it is what distinguishes this design from a residential
  proxy, keeps the user's IP reputation in their own hands, and keeps us aligned with provider
  terms (the traffic's origin address matches the traffic's actual originator, as with BYOK).
- **Consent and visibility:** client egress is **per-org opt-in** (`config.json` / dashboard, no
  env vars), surfaced in the client UI while active ("model traffic leaves from this device"), and
  killable server-side per org and globally. Default posture on managed models remains server
  egress until the org opts in.
- **What the client can observe about itself:** destination host, byte counts, timing. That is
  strictly less than BYOK clients see of their own traffic today.

### D3 — Egress mode is a per-provider setting, chosen where the provider is configured

Not every provider limits by IP — for most paid, key-metered APIs the tunnel buys nothing and costs
a hop. So egress is **not** a global behavior: it is a setting on the provider entry itself, chosen
(and changeable) wherever providers are set up — the dashboard Providers page for org/managed
providers, `config.json` for CLI-managed ones. Two layers keep it honest:

- **Capability (adapter-declared):** the `ProviderDefinition` (ADR-041 D1 registry) declares what
  is *possible* for this provider: `egressCapabilities: { vendableToken?: boolean; clientTunnel?:
  boolean }`. This is code-owned fact, not operator opinion — a provider with no ephemeral-token
  API is simply not vendable, and the settings UI only offers what the adapter declares.
- **Policy (operator-configured):** each configured provider carries `egressMode: 'server' |
  'client-tunnel' | 'vended-token'` plus an optional `'auto'` that starts at `server` and suggests
  (never silently switches to) the tunnel when the shaper observes sustained per-IP-shaped 429s
  from that provider. **Default is `server`** — the tunnel is something an operator turns on for
  the specific providers where IP limits actually bite, not a blanket behavior. The setting is
  per-provider *and* inherits the existing org-inheritance pattern (system-org default, org
  override), stored with the provider config, no new env vars.

Where `vended-token` is selected and the adapter is vendable, the gateway mints scoped, expiring
session tokens server-side and the client calls the provider directly — preferred over tunneling on
flaky links since there is no long-lived channel to keep alive. The effective mode for every
provider is visible in the same settings surface, next to the credential it protects.

### D4 — Fallback ladder within the configured mode, never a cliff

The per-provider `egressMode` picks the *top* of the ladder; the ladder below it is fixed:
**vended token** (mode `vended-token`, adapter vendable, org opted in) → **client tunnel** (mode
`client-tunnel` or the token path unavailable, live client channel, org opted in) → **server
egress** (always available, and the entirety of the ladder when the mode is `server`). Client
offline, tunnel setup exceeding a deadline, or mid-stream tunnel loss all fall back transparently —
a retry re-enters the ladder at server egress; the user sees latency, never a hard failure
introduced by this feature. Fallbacks are counted per provider and surfaced in the settings UI so
an operator can see when a configured mode is not actually being achieved.

### D5 — Rate-shaping is the floor under every path

Independent of egress, the gateway gains an explicit shaper (this also addresses the known
review-bot wedge class): per-upstream-key concurrency + rpm budgets, fair-share queueing across
orgs, `Retry-After`-honoring backpressure surfaced to callers as queue position instead of opaque
stalls, and per-org managed-key sharding (option D) so one tenant cannot starve the shared key.
Operator-supplied egress pools (option C) plug in here as additional server-side addresses if an
install wants them.

### D6 — Placement in the runtime: an `EdgeDialer` fabric, providers first

The tunnel is not a bespoke networking hack in the transport, and it is not provider-specific: it
is a **dialer seam on a shared relay fabric**. The upstream HTTP stack accepts an `EdgeDialer`
(default: direct socket from the server), and the client tunnel is a second implementation —
mirroring ADR-041's port/world pattern so a future egress mechanism (regional worker, container)
is a third dialer, not a rewrite. The frame protocol, ticket issuance, bounds, and close codes
reuse the remote-relay machinery (`tickets.ts`, bounded splice) rather than inventing a parallel
one. Managed AI providers are the **first consumer** of the fabric, not its definition — §8 names
the others and the rules every consumer inherits.

---

## 4. What this deliberately does not do

- **No shared proxy pool built from users.** The one-user rule (D2) is the design's ethical and
  ToS spine. A "route anyone through anyone" mode is rejected permanently, not deferred.
- **No client-visible long-lived credentials.** Option A stays rejected; D3's tokens are scoped
  and expiring by definition, or the provider is not vendable.
- **No change to BYOK.** Client-held org keys keep calling providers directly; this ADR only gives
  managed models the same egress locality BYOK already enjoys.
- **No plaintext inspection at the relay or client.** The relay stays payload-blind (as it is for
  device pairing); adding inspection would break the entire trust argument.

---

## 5. Risks

- **Latency:** client-tunneled bytes traverse client↔server twice. Acceptable for chat/completion
  workloads (upstream inference dominates); measured and surfaced per request; the ladder (D4)
  means latency-sensitive paths can stay on server egress.
- **Mobile/NAT flakiness:** tunnels die mid-stream. Mitigated by D4's transparent fallback and by
  preferring vended tokens (D3) on flaky links.
- **Provider fingerprinting of TLS-through-tunnel:** the TLS fingerprint is the server's stack
  regardless of path — identical to today. IP-vs-fingerprint mismatch across many users is
  observable by a provider; consent framing (D2) keeps this defensible: each address is the true
  originator.
- **Allowlist drift:** the client dials only server-named hosts; the allowlist must track provider
  endpoint changes. Kept next to `ProviderDefinition` endpoints so there is one source of truth.
- **Abuse of the org opt-in by a compromised server:** a malicious server could tunnel arbitrary
  TLS through consenting clients to allowlisted provider hosts only — bounded by the allowlist,
  the per-session ticket, and client-side display of active egress. Documented, not hand-waved.

---

## 6. Implementation slices

1. **S1 — Rate-shaper + key sharding (D5).** Pure server-side; immediately relieves today's
   per-key wedges; no client changes.
2. **S2 — `ProviderDialer` seam (D6).** Refactor upstream transport to the dialer interface with
   the direct implementation; no behavior change.
3. **S3 — Tunnel dialer over the relay substrate (D1).** Ticketed client channel, allowlisted
   dial instructions, server-terminated TLS through the splice, bounds + close codes reused.
4. **S4 — Consent, telemetry, fallback ladder (D2/D4).** Org knob, client UI indicator, kill
   switches, transparent fallback; ship dark, enable per-org.
5. **S5 — Vendable-token path (D3).** Adapter capability flag + vending endpoint for providers
   that support it.

---

## 7. Acceptance

1. With client egress enabled, a managed-model request's provider-side source IP is the client's
   (verified against an echo endpoint in tests), while a packet capture at the client shows only
   TLS ciphertext and the credential appears in no client-side memory dump of the test harness.
2. A tampered tunnel frame fails the request closed with a distinct close code; the retry lands on
   server egress without user action.
3. A second org's request is never observable on the first org's device channel (one-user rule
   test at the ticket layer).
4. With the shaper on, two orgs saturating one managed key each receive their fair share and see
   queue position; the historical free-tier stall reproduces as a bounded, labeled queue instead
   of a wedge.
5. Disabling the org knob mid-stream drains active tunnels and new requests take server egress —
   no restart.
6. Two providers configured side by side — one `egressMode: 'server'`, one `'client-tunnel'` —
   route accordingly in the same session; changing the mode in the provider settings takes effect
   on the next request without restart, and a mode the adapter does not declare capable is not
   offered by the settings UI (and is rejected by the API with a clear error).
7. A second fabric consumer (the first from §8.1 to ship) reuses the `EdgeDialer` interface,
   ticket layer, and bounds with **no changes** to the relay protocol — proving the fabric claim —
   and its channel declares its own consumer id, allowlist, and consent knob distinct from the
   provider channel's.

---

## 8. One relay, many tunnels: the fabric beyond AI providers

The substrate D1/D6 build — a ticketed, payload-blind, bounded byte tunnel between the server and
an enrolled user device — is a **connectivity fabric**. Managed-model egress is its first tenant.
This section fixes the rules that make additional tenants safe to add, and catalogs the ones we can
already see, so later work extends a fabric instead of forking relays.

### 8.1 Forward consumers (server dials *out* through the user's edge)

Same trust argument as D1 — server-held credential, server-terminated TLS, client relays
ciphertext, one-user rule (D2) applies verbatim:

| Consumer | What tunnels | Why the edge address matters |
|---|---|---|
| Connector API calls (GitHub/GitLab/Slack/Google, Track↔GitHub sync, review bot) | REST calls made with server-held OAuth tokens/installation tokens | Secondary/abuse rate limits are IP-sensitive; the traffic wears the address of the human who authorized the token, while token custody stays server-side. |
| Agent web research (`web_search` / `fetch_url`) for server-hosted sessions | Page fetches for the requesting user's own session | Datacenter IPs are bot-walled and geo-blocked; through the user's edge, the fleet agent sees the web as that user does. Composes with the visible-browsing surface on desktop. |
| Region-gated APIs | Any upstream available in the user's region but not the server's | Generalizes this ADR from rate limits to availability. |
| Pentest lens | Authorized scan traffic | Scan origin matches the engagement's authorized address, not the SaaS IP — cleaner legally and in the customer's WAF logs. |
| CVE / package-registry sweeps | Advisory and registry fetches | Same per-IP throttle relief; lower stakes. |

### 8.2 Reverse consumers (server dials *into* the user's private network)

The direction inverts, so one rule is added: **the device owner allowlists, per service, what
inside their network is reachable** — the client-side mirror of the server-side provider
allowlist. Nothing inside a user's network is dialable because the tunnel exists; it is dialable
because the owner named it.

| Consumer | What becomes reachable | Existing feature it unlocks |
|---|---|---|
| Local models as managed providers | The user's local model server on `localhost` | The local-model harness works for **server-hosted** sessions: the reverse tunnel is just another `EdgeDialer`, so the brain and fleet route to a model running on the user's own machine. |
| Firewalled enterprise databases | An intranet database, via an enrolled device or a small site agent speaking the same relay protocol | DB-backed org providers without requiring the org to expose the database publicly — a recurring enterprise deployment blocker. |
| Private git remotes / intranet APIs for fleet agents | Internal git hosting, internal services | A cloud/fleet agent clones and calls what only the enrolled device can see. |
| Localhost preview sharing | A dev server on the user's machine, published as an org-internal preview URL | Pairs with the browser panel and Track review flows. |

### 8.3 Fabric rules (every consumer, both directions)

1. **One fabric, many channels.** Consumers share the relay protocol, ticketing, bounds, and close
   codes; each gets its **own channel type** with its own consumer id, allowlist, consent knob, and
   telemetry. No channel may be reused for another consumer's traffic.
2. **Never a general proxy.** There is no SOCKS/any-destination mode in either direction — that is
   the line between a fabric and a VPN, and it is permanent. Forward channels dial only
   server-side-allowlisted hosts; reverse channels dial only owner-allowlisted services.
3. **Attribution honesty everywhere.** The one-user rule (D2) generalizes: a device carries only
   traffic belonging to its own user/org identity, and reverse channels serve only that org's
   sessions. No cross-tenant transit, ever.
4. **Payload-blind relay, always.** The relay routes ciphertext for every consumer, exactly as it
   does for device pairing today; a consumer that needs plaintext at the relay does not belong on
   the fabric.
5. **Consent is per-channel and visible.** Each channel type is separately opted into (org-level
   for forward, device-owner-level for reverse), separately killable, and visibly indicated on the
   device while active.
6. **Fail closed, fall back explicitly.** Every consumer defines its own D4-style ladder; losing a
   tunnel degrades to that consumer's server-side behavior (or a clear error for
   reverse-only resources), never to silent rerouting through another tenant's channel.

Reverse consumers (§8.2) carry deployment and security weight that deserves its own follow-up ADR
when the first one is scheduled; §8 fixes the fabric rules now so that ADR inherits them instead of
renegotiating them.

### 8.4 Deployment shape: fabric pieces as service profiles

Under ADR-041 D12 ("services are profiles"), the three subsystems this ADR touches are the natural
first service profiles, and the deploy tree already half-expects them
(`deploy/tunnel/docker-compose.tunnel.yml` exists; `deploy/brain/Dockerfile` carries the gateway
today):

- **`relay-edge`** — the WSS relay alone. It is the piece that *wants* independent deployment:
  scaled horizontally at the network edge (regionally, near users, for tunnel latency), stateless
  but sticky-by-grant exactly as the multi-instance boundary in
  `services/remoteRelay/server.ts` already documents, and upgradeable without touching the brain.
  Every §8 channel type rides the same edge deployment.
- **`provider-gateway`** — the `:3748` data plane plus the `EdgeDialer` selection logic. Scales
  with request volume, independently of memory/agent load.
- **`rate-shaper`** — the D5 queue/fair-share layer. Must be a **single logical control point per
  managed key** (a per-instance shaper defeats fair-share), so when the gateway scales out, the
  shaper is either the one shared instance the gateways consult or a store-backed token bucket —
  its profile declares which.

All three run in-process in the default single-node install — the profile split is the
scale-out/eu-edge story, not the baseline. The binding between gateway and relay-edge (and between
brain and either) is a remote-capable seam per ADR-041 D12: same code, in-process or remote,
switched by profile config, visible in `--dump-composition`, with each image reduced to
"loader + profile".
