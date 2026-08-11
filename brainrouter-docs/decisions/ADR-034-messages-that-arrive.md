# ADR-034 — Messages that arrive

**Status:** ACCEPTED — owner-approved on 2026-08-11.

**Target:** `release/0.4.20`.

**Implementation status:** COMPLETE. Core, Brain, CLI, and Desktop implement the same exact-key
address space, recipient trust gate, safe-boundary application, durable remote lifecycle, and
truthful receipts. The reproducible §12 command combines production host suites, an adapter-class
Brain-offline composition, and two isolated install identities over MCP/Postgres. Full hosted CI
remains the child pull request's mandatory merge gate; no physical multi-device run is claimed.

**Depends on:**

- [ADR-007](ADR-007-postgres-memory-store.md) for the native asynchronous Postgres store;
- [ADR-010](ADR-010-enterprise-multitenancy.md) for organization and user isolation;
- [ADR-027](ADR-027-compounding-debt-graph-execution-and-workbench-modernization.md) D8 for
  session identity/title lifecycle and D12 for idempotent bounded queues; and
- [ADR-028](ADR-028-surfaces-that-tell-the-truth.md) for truthful delivery states and reconciled
  steering receipts.

ADR-019 is not a dependency; it governs the application-wide organization/workspace selector,
not session federation.

---

## 1. Context

BrainRouter already had active-session heartbeats and a pull-based inbox. That foundation could
persist a row, but it did not establish that a live recipient was the intended session, wake a busy
recipient, distinguish persistence from application, protect a recipient with mutation authority,
or provide the same behavior when the Brain was offline.

This ADR closes the architecture gap with one rule:

> A peer message is untrusted input addressed to an exact live session. Persistence happens before
> wake-up, application happens only at a model-safe boundary, and every failure is a visible receipt.

The feature is session steering, not a general chat fabric and not delegated task execution.

## 2. Required properties

1. Two first-party sessions on one installation communicate while the Brain and network are
   unavailable.
2. Sessions on different installations communicate through the Brain without weakening tenant
   isolation.
3. A title helps a person choose; only an exact session key routes.
4. A wake is only a hint. A durable inbox and poll path remain authoritative.
5. A peer message never becomes a user-role message and never inherits the recipient's authority.
6. Peer steering waits for a complete model/tool boundary and never calls `requestInterrupt()` or
   aborts an in-flight turn.
7. Elevated or unknown recipient mutation authority holds the message for a human at the recipient.
8. Queue depth, fanout, age, text size, body size, and receipt retention are fixed and tested.
9. CLI and Desktop consume the same contracts and address space.

## 3. Questions Q1–Q6 — settled answers

| Question | Accepted answer |
|---|---|
| **Q1 · What identifies one installation?** | A cryptographically random UUID persisted once under the private BrainRouter home. A corrupt identity fails closed instead of silently minting a new peer identity. A logical session key is created for a new conversation and reused when that conversation resumes; per-incarnation listener ids plus a database-clocked MCP connection lease prevent concurrent live claims across Brain processes. |
| **Q2 · How do same-installation sessions discover and authenticate each other?** | Each live session binds an ephemeral listener to `127.0.0.1` and writes an instance-specific, mode-`0600` registry record beneath a mode-`0700` directory. The target's random 256-bit bearer token authenticates health and delivery before the body is read; an HMAC made with the sender's independent registry capability binds the exact sender, target, install id, content, and timestamp. |
| **Q3 · How does cross-installation delivery work?** | The Brain transactionally persists tenant-scoped inbox rows and sender receipts in Postgres, then emits an ID-only wake. MCP notifications wake a connected recipient; transaction-coupled `NOTIFY` and a reconnecting `LISTEN` feed carry wakes between Brain processes. Polling the durable inbox is the reconnect and loss fallback. |
| **Q4 · How does a message affect a busy turn?** | It queues as typed peer steering and is applied at the next complete model/tool boundary. It does not call `requestInterrupt()`, set the cooperative interrupt flag, or abort the turn controller. |
| **Q5 · When is recipient approval required?** | The recipient evaluates a transport-neutral authority tuple. A host presents held messages through its generic human-interaction protocol (`InteractionPort` in CLI, `InteractionBroker` in Desktop); a missing or dismissed human interaction stays held. Auto-application is permitted only when every mutation surface is denied or guaranteed to ask the human again. |
| **Q6 · What are the bounds?** | Pending/held TTL 24 hours; terminal receipt retention seven days; pending depth 100 per recipient; fanout 100; local accepted-id ledger 1,000; durable held/terminal records 1,000; text 20,000 UTF-8 bytes; local HTTP body 64 KiB. Overflow, expiry, ambiguity, conflicts, rejection, and oversize input produce loud receipts. |

### 3.1 Q1 details — install identity and session identity are different

`getLocalMessagingDeviceId()` creates a random UUID once and stores it in
`session-messaging/device.json`. The identity file and its directory are private, symlinks are
refused, size is bounded, and an invalid stored value is an error. This identity answers only
“same BrainRouter installation?” It is not an account credential and is never accepted as tenant
authority.

`resolveFederationSessionKey()` uses the Agent conversation's stable session key. Resuming that
conversation therefore reclaims its durable inbox after a crash; starting a new conversation
creates a new key, even when a human reuses the same label. Renaming changes only human discovery
metadata and never changes the routing key. The loopback registry's random instance id and the
remote renewable connection claim remain per-incarnation. The remote claim is atomically fenced
in Postgres and validated on heartbeat, send, read, transition, receipt, wake, and cleanup, so two
Brain processes cannot
silently share one address. Two different conversations in the same workspace remain distinct.

Per-session disk state preserves that exact identity too. Unambiguous short legacy directory names
remain readable; exact-boundary and long keys use a private exact-key marker plus a collision-resistant
hash bucket. A non-empty ambiguous directory created by an older truncating layout fails loudly for
manual recovery instead of being guessed, merged, or silently resumed as empty. Session metadata
mutations hold a cross-process lock through validation and durable replacement, so concurrent hosts
cannot lose rows or let a late lower-priority title overwrite a human or hook title. Corrupt, oversized,
symlinked, or schema-invalid metadata fails closed.

### 3.2 Q2 details — authenticated loopback, not a broker daemon

The local route has no resident broker and no backend dependency. Each participant owns its
listener lifecycle. Registry filenames hash the session key and include a random instance id;
cleanup can therefore remove only the exact listener instance it created. Discovery probes the
authenticated health endpoint, verifies protocol, device id, session key, and instance id, then
reaps an unreachable or malformed entry. Delivery additionally proves one exact live sender with
an HMAC over the envelope; possessing only the recipient token cannot impersonate another session.

The client never treats the registry as an arbitrary URL. It reconstructs every request against
`127.0.0.1` and a validated numeric port. Duplicate live claims for one exact key are ambiguous and
refused rather than resolved by recency or title.

### 3.3 Q3 details — persist, wake by id, then poll if necessary

The remote path is ordered:

1. authenticate the MCP connection, atomically lease the exact session key in Postgres, and pin
   `(orgId, userId, fromSessionKey, claimToken)` on the server;
2. require the sender and exact recipient to be active in that tenant;
3. transactionally reserve the sender-generated `messageId`, enforce fanout/depth, and persist one
   inbox/receipt row per recipient;
4. commit the transaction;
5. wake by recipient session key and inbox ids only; and
6. let the recipient read the payload from the durable inbox and acknowledge its resulting state.

The wake never carries message content. A failed stream, lost notification, process restart, or
temporary `LISTEN` disconnect cannot lose the row. It changes latency only; polling remains the
correctness path.

### 3.4 Q4 details — steering is not cancellation

`requestPeerSessionSteer()` appends typed pending steering. `applyPendingSteeringAtBoundary()`
drains it only between complete model/tool batches, records a steering receipt, adds a trusted
system reconciliation record, and appends the peer content as an assistant observation named
`peer-session` with authenticated provenance and `trust: "untrusted-session"`.

The boundary also revalidates the envelope's absolute deadline. A remote poll preserves the
Postgres row's `expiresAt`; a late read cannot start a second 24-hour clock. Local live delivery has
no database deadline and therefore uses 24 hours from recipient admission.

Cancellation remains separate:

- cancelling before persistence creates no delivery row;
- cancelling the sender after persistence does not retract a committed message;
- a peer message never aborts the recipient's current model call or tool; and
- this ADR adds no recall/retract verb. A correction is another idempotent message.

### 3.5 Q5 details — recipient-owned, transport-neutral approval

The recipient evaluates five mutation surfaces. The most conservative value wins:

| Effective authority for a surface | Recipient action |
|---|---|
| `denied` | May auto-apply as untrusted steering; the surface cannot mutate. |
| `confirm` | May auto-apply as untrusted steering; any later mutation still requires a human. |
| `allow` | Hold for explicit recipient approval. |
| `unknown` or omitted | Hold; uncertainty never becomes authority. |

Surfaces are `workspaceFiles`, `shell`, `computerUse`, `externalWrites`, and `remoteTools`. If any
surface says hold, the whole message is held. Approval, rejection, expiry, and applied state are
durable and idempotent. Approval replays until application is acknowledged; an applied approval
does not replay.

Presentation belongs to the generic host interaction layer: CLI adapts the `InteractionPort`, and
Desktop adapts the `InteractionBroker` plus its resolved-event bridge. Both resolve the same durable
recipient decision; neither transport owns approval. Headless, dismissed, timed-out, or
disconnected interactions have no implicit approval path and leave the record held.

### 3.6 Q6 details — fixed lifecycle and loud shedding

| Bound | Accepted value | Failure state |
|---|---:|---|
| Local/remote pending depth per recipient | 100 | `queue_full` / `not_queued` |
| Broadcast fanout | 100 | whole send rejected; no partial fanout |
| Local accepted-id dedupe ledger | 1,000 within the 24-hour window | `queue_full`; accepted ids are never silently evicted |
| Durable held/terminal record store | 1,000 | `queue_full`; retained decisions are never silently overwritten |
| Pending or held age | 24 hours | `expired` receipt/notices |
| Terminal receipt retention | seven days | swept after retention, or earlier after sender acknowledgement |
| Message text | 20,000 UTF-8 bytes | `payload_too_large` |
| Local request/response body | 64 KiB | request refused before unbounded buffering |

Remote statuses are `pending`, `held`, `applied`, `rejected`, `declined`, `expired`, and
`queue_full`. The SQL constraint and shared TypeScript list have an exact parity test.

## 4. Decisions D1–D7

### D1 · One address space, exact keys, descriptive discovery

Local and remote routes use the same exact session key. Titles, workspace, device, client kind,
activity state, and last-seen time are discovery metadata only. A title collision never routes.
When one exact key is visible locally and remotely, the verified local route wins and the duplicate
is hidden. A self-send or duplicate live local claim is refused.

Every successfully finalized first user turn also produces a bounded discovery title.
`deriveSessionTitle()` is persisted and emitted immediately as the deterministic `derived` floor.
A bounded asynchronous model proposal
may CAS-replace that floor with source `agent`; invalid output, refusal, timeout, or provider failure
leaves the derived title intact. Precedence is `human > hook > agent > derived`, so a late proposal
cannot overwrite a stronger title. CLI and Desktop publish each winning metadata update to their
live registration. Titles remain display metadata and never route.

### D2 · Same-installation delivery is authenticated and Brain-offline

Same-installation delivery uses the two-sided authenticated loopback registry described in Q2.
Successful local admission means only “queued in the live recipient's bounded mailbox”; it never
claims that a model read or applied the content. Local messages are not mail: if either the exact
sender or exact recipient is not live, the send fails loudly instead of writing a file for a future
process.

### D3 · Cross-installation delivery is durable and tenant-pinned

Remote identity is `(orgId, userId, sessionKey)`. Organization and user come from authenticated
server context, not tool arguments. The sender must own the unexpired database claim for that MCP
connection; the recipient must have one current claim in the same tenant. A failed claim validator
also reaps a stale process-local wake binding. Broadcast excludes the sender and is all-or-none when
it exceeds fanout 100.

The sender supplies an idempotency key. Reuse with identical canonical content returns the original
receipts; reuse with different recipient, kind, or content fails with an explicit id conflict.

### D4 · Peer content enters only at a safe model boundary

The recipient converts a verified envelope to `PeerSessionSteeringInput`. It records sender session,
device, client, title, and transport provenance, but provenance establishes identity rather than
authority. The content is never appended with role `user`. Existing goal/plan reconciliation and
steering receipt machinery remain authoritative.

### D5 · The recipient owns the trust decision

No transport may decide that an instruction is safe. The authority matrix in Q5 executes inside the
recipient host for local and remote paths alike. Unknown authority holds. The generic host
interaction protocol owns human presentation; transport-specific approval concepts are rejected.

### D6 · Every state is truthful, durable where it must be, and bounded

“Queued”, “persisted-unseen”, “held”, and “applied” are different states. A wake is not delivery, a
database insert is not model application, and an approval is not application until acknowledged.
Queue-full, expiry, rejection, ambiguity, unreachable routes, oversize input, and id conflicts are
returned rather than logged and hidden.

Local live-mailbox state is deliberately process-local. Local held approvals are persisted beneath
the recipient workspace. Remote inbox and sender receipts are durable Postgres rows. Terminal
receipts remain visible for seven days unless the sender acknowledges them earlier.

The remote row's absolute expiry is carried through recipient admission, durable hold, and
safe-boundary steering. Approval or delayed polling never extends it. Presentation surfaces strip
terminal control sequences from peer labels and text while retaining the original untrusted content
for the mailbox, transcript, and model context.

### D7 · CLI and Desktop are equal participants, proved by one reproducible command

Both first-party interactive hosts must register, discover, send, receive, hold/approve/decline, and
apply at the same safe boundary using shared core contracts. A CLI-only result does not complete
this decision.

Final acceptance is one same-machine automated command, not an anecdotal physical-device run. It
composes production-host, focused security/lifecycle, and end-to-end transport tests into these
phases:

- **Brain-offline phase:** one temporary BrainRouter home (one persisted install identity), two
  isolated live host instances, Brain disabled. Verify exact-key discovery, local preference,
  authenticated send, safe-boundary application, held approval, truthful receipt, duplicate id,
  queue full, expiry, and stale-instance reaping.
- **Cross-installation evidence:** a two-identity MCP delivery phase plus a distributed-claim phase,
  using two different temporary BrainRouter homes, isolated MCP clients, two independent
  feed/hub/store participants, and scratch Postgres databases. Verify remote selection, distributed
  live-claim exclusion, tenant pinning, persist-before-ID-only-wake, multi-process `LISTEN` fan-in,
  wake-loss polling, idempotent replay/conflict, receipt transitions, and cleanup.

This command runs two device identities on one machine. It is deterministic and CI-suitable. It is
not evidence that a physical network or two live devices were exercised.

## 5. Ownership

| Concern | Owner | Primary implementation |
|---|---|---|
| Shared remote records, statuses, limits | shared types | `packages/types/src/memory/session.ts`, `packages/types/src/store.ts` |
| Title fallback, precedence, persistence, and live publication | browser-safe shared types + core session metadata + hosts | `packages/types/src/session-title.ts`, Core `sessionTitle.ts`/`sessionMetaStore.ts`, first-turn callbacks |
| Local identity, registry, listener, client, mailbox, route merge | core session messaging | `packages/core/src/session/messaging/` |
| Peer envelope and safe-boundary application | core session input/runtime | `packages/core/src/session/input/inputDelivery.ts`, `packages/core/src/agent/runtime/steering.ts` |
| Recipient authority and durable hold lifecycle | core agent/session | `packages/core/src/agent/guards/sessionMessageApproval.ts`, `packages/core/src/session/input/heldSessionMessages.ts` |
| Durable inbox, receipts, idempotency, limits, expiry | Brain Postgres store | migration 058 and Postgres session queries |
| Transaction-coupled cross-process wake | Brain Postgres store | `sessionMessageNotificationFeed.ts` and the store subscription |
| Authenticated MCP ownership, ID-only wake, poll fallback | Brain MCP transport | session tools, `SessionDeliveryHub`, `mcpServer.ts` |
| Untrusted peer presentation sanitization | browser-safe shared types + hosts | `packages/types/src/peer-presentation.ts`, CLI/Desktop presentation surfaces |
| Terminal participant lifecycle and admission | CLI host | `federationRegistration.ts`, `peerMessageAdmission.ts`, chat host wiring |
| Graphical participant lifecycle and approval UI | Desktop host | `sessionMessaging.ts`, `PeersPanel.tsx`, InteractionBroker bridge |
| Reproducible acceptance command | repository verification | focused suites plus `adr034-host-adapters.test.mts` and `adr034-acceptance.node-test.ts` |

## 6. Compatibility

- Older Brains that do not advertise registration/heartbeat tools leave federation disabled; the
  CLI remains usable.
- A recipient without wake capability continues polling. Notification negotiation is additive.
- Existing personal sessions normalize an omitted organization to the personal tenant; new remote
  sends use server-pinned organization context.
- Migration 058 backfills existing inbox ids as message ids and maps old delivered rows to
  `applied`, preserving prior rows before adding the lifecycle constraint.
- Migration 058 gives existing active-session rows a bounded legacy lease. First-party clients
  re-register when heartbeat reports that their current MCP connection does not own it.
- Existing unambiguous short per-session state paths remain readable. A non-empty legacy long-key
  bucket is inherently ambiguous because earlier releases truncated its name, so the new runtime
  refuses automatic adoption and reports a recovery-required error rather than risking cross-session
  state.
- The legacy store send/read/ack methods remain adapters while first-party handlers migrate to the
  authoritative route API.
- Reserved non-text message kinds remain durable records but are not automatically injected as
  text steering.

## 7. Security and privacy

- Local listeners bind only `127.0.0.1`; registry ports never become arbitrary outbound URLs.
- Private directories/files, no-follow reads, identity/schema validation, hashed registry
  filenames, and per-instance capabilities reduce same-user process confusion and symlink
  substitution. They are not an operating-system account isolation boundary.
- Target authentication happens before local body handling; the sender HMAC binds the accepted
  envelope to one exact same-installation sender. Both body and text are bounded.
- Remote authorization is the authenticated `(orgId, userId, sessionKey)` tuple. Tool arguments
  cannot select another tenant or impersonate a sender key owned by another connection.
- Active exact-recipient validation prevents delivery to a recycled label or inactive row.
- Peer content is always `untrusted-session`; sender authentication does not grant instruction
  authority.
- No cross-user or cross-organization messaging is in scope.

## 8. Failure, cancellation, and recovery semantics

| Event | Required outcome |
|---|---|
| Local registry entry is stale or listener fails authentication/probe | Reap only that instance; return `unreachable`/`not_found`. |
| Two live local instances claim one exact key | Return `ambiguous`; never guess. |
| Two Brain processes claim one exact remote key | Postgres atomically accepts one unexpired lease; reject the loser and fence every stale operation/wake by claim token. |
| Remote sender is inactive or does not own its connection key | Reject before trusted persistence. |
| Exact remote recipient is inactive or in another tenant | Persist a sender-visible rejection only after sender validation. |
| Postgres commit succeeds but wake fails | Return persisted-unseen/poll fallback; recipient polls the row. |
| Wake arrives twice | Read/deduplicate by inbox/message id; do not enqueue twice. |
| Same message id carries different content | Loud id conflict; original delivery remains unchanged. |
| A pre-upgrade long session key maps to a non-empty truncated state bucket | Fail with a recovery-required ambiguity; never create a fresh hashed bucket or guess ownership. |
| Recipient queue reaches 100 | Reject that recipient with `queue_full`; pending depth never exceeds 100. |
| Broadcast resolves to more than 100 recipients | Reject the whole logical send; no partial fanout. |
| Pending/held row reaches 24 hours without a durable application acknowledgement | Move to `expired` and retain the sender-visible terminal receipt. Expiry alone proves neither application nor non-application across a crash seam. |
| Recipient host has unsafe or unknown mutation authority | Persist `held`; no steering application until recipient approval. |
| Sender or recipient exits after commit | Do not retract or silently mark applied; durable lifecycle remains queryable. |
| Recipient stops mid-turn | Existing cancellation owns the stop. A peer message never requests it. |

## 9. Consequences

### Benefits

- Same-installation messaging has no Brain/network availability dependency.
- Remote wake latency improves without making a lossy notification the source of truth.
- Exact identity, active validation, and tenant pinning eliminate label-based misrouting.
- Safe-boundary injection preserves complete tool/model operations and sender provenance.
- The authority matrix is host- and transport-neutral and fails closed.
- Fixed limits make overload, expiry, and retention observable and testable.

### Costs and trade-offs

- Each live local participant owns a loopback listener and private registry record.
- Local queued messages disappear with the live recipient process; the sender was promised only
  live mailbox admission, not offline mail.
- Postgres stores one row per fanout recipient plus a logical-send idempotency row.
- Every Brain process needs a reconnecting `LISTEN` connection for low-latency multi-process wake;
  polling still consumes periodic reads as the fallback.
- Conservative unknown authority increases held-message volume until every host supplies an exact
  authority tuple and approval surface.

## 10. Dependency-ordered implementation slices

| Order | Slice | State on 2026-08-11 | Exit condition |
|---:|---|---|---|
| 1 | Shared contracts, exact identity, titles/state metadata, validation and bounds | Implemented | Remote and local both enforce the accepted 20,000 UTF-8-byte rule. |
| 2 | Persisted install identity, authenticated local registry/listener, mailbox and route merge | Implemented | Brain-offline two-host core tests pass. |
| 3 | Tenant-scoped Postgres inbox/receipts, idempotency, limits, expiry and migration parity | Implemented | Scratch-Postgres tests pass under contention. |
| 4 | Transaction-coupled `NOTIFY`, reconnecting `LISTEN`, MCP ID wake and poll fallback | Implemented | Commit-before-wake and failed-stream fallback tests pass. |
| 5 | Typed peer steering, provenance, recipient authority classifier and durable held lifecycle | Implemented | Both hosts use their generic interaction protocol; headless/dismissed stays held. |
| 6 | CLI participant lifecycle and admission | Implemented | CLI completes approve/decline/apply and preserves retryable receipt state across restart. |
| 7 | Desktop participant lifecycle, discovery/send/receive and approval UI | Implemented | Desktop passes the same adapter contract and restart/switch cases as CLI. |
| 8 | Composite two-identity acceptance harness, docs and hosted CI gate | Implemented | §12 command passes locally; the child PR requires the full hosted suite before merge. |

## 11. Taskboard

- [x] Persist a random installation UUID privately and fail closed on corruption.
- [x] Use resume-stable logical session keys, per-incarnation live claims, and exact-key routing.
- [x] Build authenticated loopback discovery, liveness probing and stale reaping.
- [x] Enforce the same 20,000 UTF-8-byte text rule on local and remote paths, plus the 64-KiB body,
  depth 100 and 24-hour local expiry bounds.
- [x] Add tenant-scoped active-session and inbox persistence.
- [x] Add sender idempotency, active exact-recipient validation, self-exclusion and fanout 100.
- [x] Add durable statuses, sender receipts, 24-hour expiry and seven-day terminal retention.
- [x] Add transaction-coupled Postgres notification and reconnecting multi-process feed.
- [x] Add MCP ID-only wake, connection ownership and poll fallback.
- [x] Add typed peer steering that applies at a safe boundary without interruption.
- [x] Add the conservative authority matrix and durable held-message state machine.
- [x] Wire the CLI participant lifecycle and recipient admission.
- [x] Route held-message approve/decline presentation through each host's generic interaction
  protocol, with dismissal/timeout remaining held.
- [x] Wire Desktop registration, discovery, send, receive, state/title refresh and cleanup.
- [x] Add and run the composite same-machine Brain-offline/two-identity MCP/Postgres harness.
- [x] Declare the full hosted CI suite as a mandatory ADR-034 child-PR merge gate.

## 12. Acceptance evidence D1–D7

Component and composite evidence are implementation-backed and reproducible. The commands below
establish local acceptance; hosted CI is the independent merge gate recorded on the child pull
request.

| Decision | Evidence | Exact command | Current result |
|---|---|---|---|
| **D1** exact identity and one address space | registry/route tests, collision-safe `state.test.ts`, cross-process `sessionMeta.test.ts`, Core title policy/model tests, CLI `turn-runner-session-title.test.ts`, Desktop `hostCore.peerSessions.test.ts`, and Dashboard fallback parity | `npm run test:adr034:acceptance` | Persisted install identity, collision-safe exact-key state, fresh-key creation, resume-stable routing, title precedence, and derived/agent live publication without title-based routing are covered. |
| **D2** authenticated Brain-offline local delivery | `session-messaging-local.test.ts` and hostile/authentication cases in `session-messaging-bounds.test.ts` | `node --import tsx --test packages/core/src/tests/session-messaging-local.test.ts packages/core/src/tests/session-messaging-bounds.test.ts` | Component tests implemented; exercises two offline hosts on one temporary identity. |
| **D3** durable tenant-pinned remote delivery and ID wake/poll | `session-inbox.node-test.ts`, `session-claim.node-test.ts`, `sessionMessageSchema.test.ts`, `sessionMessageNotificationFeed.test.ts`, `sessionDeliveryHub.test.ts`, `mcpServer.session-messaging.test.ts`, `session-message-notification.test.ts` | `npx vitest run brainrouter/src/memory/store/postgres/sessionMessageSchema.test.ts brainrouter/src/memory/store/postgres/sessionMessageNotificationFeed.test.ts brainrouter/src/services/sessionDeliveryHub.test.ts brainrouter/src/transport/mcpServer.session-messaging.test.ts && node --import tsx --test --test-concurrency=1 brainrouter/src/__tests__/session-inbox.node-test.ts brainrouter/src/__tests__/session-claim.node-test.ts && node --import tsx --test packages/core/src/tests/session-message-notification.test.ts` | Scratch-Postgres contention and a two-store/two-feed/two-hub race prove one distributed lease winner, stale-owner fencing, takeover, tenant isolation, transaction-coupled wake fan-in, and wake-loss recovery; no physical-device claim. |
| **D4** safe-boundary peer steering without interruption | `peer-session-steering.test.ts`; peer cases in `external-steering.test.ts` and `agent-runtime.test.ts` | `node --import tsx --test packages/core/src/tests/peer-session-steering.test.ts packages/core/src/tests/external-steering.test.ts packages/core/src/tests/agent-runtime.test.ts` | Core path includes retry-safe suffix restoration and absolute-deadline revalidation before model-visible application. |
| **D5** recipient authority and durable hold | Core classifier/store tests plus CLI/Desktop approval and interaction lifecycle tests | `node --import tsx --test packages/core/src/tests/session-message-approval.test.ts packages/core/src/tests/held-session-messages.test.ts && npm run test:adr034:acceptance` | Fail-closed authority, cross-process hold serialization, approve/decline/dismiss, and exactly-once presentation/application are covered. |
| **D6** bounds, receipts, expiry, idempotency and contention | `session-messaging-bounds.test.ts`; queue/fanout/retention cases in `session-inbox.node-test.ts`; schema parity and multibyte MCP tests | `node --import tsx --test packages/core/src/tests/session-messaging-bounds.test.ts && node --import tsx --test --test-concurrency=1 brainrouter/src/__tests__/session-inbox.node-test.ts && npx vitest run brainrouter/src/memory/store/postgres/sessionMessageSchema.test.ts brainrouter/src/transport/mcpServer.session-messaging.test.ts` | Local, MCP and Postgres component coverage implemented. |
| **D7** CLI/Desktop parity and reproducible end-to-end proof | Production CLI/Desktop host suites, an adapter-class Brain-offline composition phase, and an isolated two-identity MCP/Postgres phase | `npm run test:adr034:acceptance` | One command builds all participating packages and exercises HostCore/interaction wiring, adapter lifecycle, local preference/bounds/reaping, remote claim exclusion, wake loss/poll replay, id conflicts, restart recovery, and terminal receipts. |

`npm run test:adr034:acceptance` creates its temporary homes, listeners, isolated MCP connections,
and scratch Postgres databases; it cleans them itself and never prints raw installation identities.
It requires a reachable Postgres admin server configured by `BRAINROUTER_TEST_PG_ADMIN_URL`,
`BRAINROUTER_DATABASE_URL`, or `DATABASE_URL`, and otherwise uses the repository's local Docker
default. It proves two different persisted install identities on one machine, not two physical
devices.

## 13. Out of scope

- Cross-user or cross-organization messaging.
- General publish/subscribe infrastructure.
- Offline mail to a local session process that does not exist.
- Replacing task delegation or worker orchestration.
- Routing by title, workspace, client kind label, or device name.
- Treating a wake, receipt, approval, or persisted row as proof that a model acted.
