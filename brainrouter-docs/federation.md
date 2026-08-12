# Federation and session messages

BrainRouter federation gives first-party interactive hosts one shared view of live sessions and one
exact-key message address space. Presence, local delivery, and Brain-mediated delivery are related
but distinct:

- a **session key** identifies one logical conversation and its current live incarnation;
- a **device id** identifies one BrainRouter installation;
- an authenticated **organization and user** identify the remote tenant; and
- a **title** helps a person choose a session but never routes a message.

The accepted architecture and current completion evidence are recorded in
[ADR-034](decisions/ADR-034-messages-that-arrive.md).

## Current implementation status

Core, Brain, CLI, and Desktop implement the shared transport, durable inbox/receipts,
cross-process wake feed, safe-boundary steering, generic human approval, and exact-key participant
lifecycle. The reproducible acceptance command combines production host suites, adapter-class
Brain-offline composition, and isolated remote durability phases. Hosted CI remains the child pull
request's merge gate.

## Presence at a glance

| Surface | What it shows |
|---|---|
| `/agents --remote` | Active remote sessions: exact key, client kind, heartbeat age, workspace and optional usage. |
| `/agents --remote --watch` | A bounded 20-second watch rather than an unbounded terminal mode. |
| `/agents --remote --usage` | Token and cost snapshots reported by each participant. |
| `/agents --remote --include-stale` | Rows outside the two-minute active window but not yet swept. |
| `/agents --remote --json` | Machine-readable presence for scripts and diagnostics. |
| Local discovery | Live same-installation listeners with title, workspace, activity state and exact key. |

Third-party MCP clients do not become messaging participants merely by connecting to the Brain.
A participant must implement registration, heartbeat, inbox polling/wake handling, recipient
admission, and cleanup.

## Identity

### Logical session key and live incarnation

A new conversation receives a random session key, even when its optional human label repeats an
older label. Resuming that conversation reuses its key so a crashed recipient can reclaim and poll
durable rows; renaming changes only discovery metadata, while starting a different conversation
creates a different address. Listener instance ids and MCP connection ownership are
per-incarnation, so two concurrent processes cannot silently own the same key. Remote ownership is
an atomic, database-clocked lease validated on every message lifecycle operation and wake. Graceful
shutdown
releases the current incarnation; a hard-killed remote process becomes inactive after missed
heartbeats and its lease becomes reclaimable.

The session key is the only routing identity. Exact prefixes may be a CLI convenience only after
they resolve unambiguously to one live key; a title or client-kind label never replaces the key in a
delivery envelope.

Per-session persistence uses reversible legacy names only where they are unambiguous. Exact-boundary
and long keys use private exact-key markers and collision-resistant hash buckets. If an older release
left a non-empty truncated long-key bucket, BrainRouter refuses to guess or silently start empty and
reports that the state needs manual recovery. Session title metadata is likewise updated under a
cross-process lock with strict, durable validation.

### Persisted installation id

Local discovery also records a cryptographically random installation UUID persisted beneath the
private BrainRouter home. Every process using that home shares the id. A different BrainRouter home
has a different id, even when both run on the same physical machine.

The id selects local versus remote transport; it is not account authority. Remote organization and
user scope still come from authenticated Brain context.

## One address space, two transports

| Route | Selection | Source of truth | Offline behavior |
|---|---|---|---|
| **Local** | Recipient has a verified live listener with the same persisted installation id. | Recipient's bounded live mailbox. | Works with the Brain and network unavailable. |
| **Remote** | Recipient is active in the same authenticated Brain tenant on another installation. | Durable Postgres inbox and receipts. | Requires the Brain; a lost wake falls back to polling. |

If the same exact key is visible through both transports, the verified local route wins and the
remote duplicate is hidden. More than one live local listener claiming the same exact key is
`ambiguous` and sends refuse rather than guessing.

Self-send is refused on both paths.

## Local transport

Each live participant:

1. binds an ephemeral listener to `127.0.0.1`;
2. creates a random listener instance id and 256-bit bearer token;
3. writes an instance-specific registry record beneath a mode-`0700` directory as mode `0600`;
4. authenticates health and target delivery before reading the body;
5. requires an HMAC made with the exact sender's independent registry capability, binding sender,
   target, install id, content, and timestamp;
6. accepts only the exact target session key into a bounded mailbox; and
7. removes only its own registry instance during graceful shutdown.

Registry records are data, not URLs. Clients always rebuild requests against loopback and a
validated numeric port. Registry filenames hash session keys so arbitrary keys do not become path
components. Discovery probes protocol, device id, session key, and listener instance; an
unreachable or malformed instance is reaped.

### Local receipt meanings

| Receipt | Meaning |
|---|---|
| `queued` | The exact live recipient admitted the message to its mailbox. It does not mean a model saw it. |
| `not_found` | No registry record claims the exact key on this installation. |
| `unreachable` | The claimed listener did not pass its authenticated probe or delivery request. |
| `ambiguous` | More than one live instance claimed the exact key. |
| `queue_full` | The recipient has 100 pending messages or its 1,000 accepted-id/held-history safety bound is full. |
| `expired` | The sender timestamp is already outside the 24-hour window. |
| `payload_too_large` | Text exceeds 20,000 UTF-8 bytes or the HTTP body exceeds 64 KiB. |
| `id_conflict` | The id was previously accepted with different content. |
| `self_send`, `invalid_message`, `rejected` | The corresponding address, validation, or recipient-policy check failed. |

Accepted local ids deduplicate retries. Identical reuse returns `duplicate: true`; conflicting reuse
does not replace the original. The 1,000-id ledger retains accepted ids for the same 24-hour window
and refuses new unique ids instead of silently evicting dedupe evidence. The durable held/terminal
store is likewise capped at 1,000 records.

Local mailboxes belong to live processes. They are not offline mail stores. If the recipient exits,
future local sends fail and any process-local pending rows disappear. Messages held for human
approval use the separate durable recipient hold store.

## Remote transport

Remote sends use the Brain tools and the authenticated MCP connection:

1. the connection atomically leases and owns an active `(orgId, userId, sessionKey)` tuple;
2. the sender supplies an exact target or one of the bounded broadcast forms;
3. the Brain validates the active sender and recipients in that tenant;
4. Postgres persists the logical send, per-recipient inbox rows, and sender receipts atomically;
5. commit emits a bounded ID-only notification;
6. connected Brain processes receive it through transaction-coupled `NOTIFY`/`LISTEN`;
7. the MCP stream wakes the matching recipient with inbox ids; and
8. the recipient reads payloads from the durable inbox. Polling covers reconnects and lost wakes.

No payload travels in a wake notification. A wake says only “these durable ids may be available.”

### Remote addressing

| Form | Meaning |
|---|---|
| exact `<sessionKey>` | One exact active session in the authenticated tenant. |
| `<clientKind>:*` | Every active session of that kind, excluding the sender. |
| `*` or `broadcast` | Every active session in the tenant, excluding the sender. |

Exact recipients must be active. A same-key row in another organization or user partition is not a
recipient. Fanout greater than 100 rejects the whole logical send; it never partially broadcasts.

### Remote receipt lifecycle

| State | Meaning |
|---|---|
| `pending` | Persisted and available to the recipient; not yet applied. |
| `held` | Recipient authority requires a human decision. |
| `applied` | Recipient acknowledged safe-boundary application. |
| `rejected` | Address, validation, or recipient policy rejected it. |
| `declined` | The recipient human declined a held message. |
| `expired` | No durable application acknowledgement was recorded before the 24-hour TTL. This does not prove non-application after a crash. |
| `queue_full` | Recipient already had 100 pending/held messages. |

Pending and held rows expire after 24 hours. Terminal receipts remain sender-visible for seven days
unless the sender acknowledges them earlier. The logical sender-generated message id deduplicates
retries across changing broadcast membership; reuse with different address, kind, or canonical
content is an explicit conflict.

## Recipient trust and safe-boundary application

Every inbound peer envelope becomes `trust: "untrusted-session"`. Authentication proves which
session sent it; it does not give that session user authority.

The recipient evaluates five mutation surfaces:

| Authority | Action |
|---|---|
| `denied` | The message may enter as untrusted steering. |
| `confirm` | The message may enter; a later mutation still asks the human. |
| `allow` | Hold for explicit recipient approval. |
| `unknown`/omitted | Hold. |

The surfaces are workspace files, shell, computer control, external writes, and remote tools. One
unsafe or unknown surface holds the whole message. Hosts present held records through their generic
human-interaction protocol (CLI `InteractionPort`, Desktop `InteractionBroker`); if no human surface
is available or the interaction is dismissed, the message stays held.

Approved peer content is queued as typed steering. It is applied only between complete model/tool
batches with a reconciliation record and sender provenance. It is an assistant observation named
`peer-session`, never a user-role message. It does not call `requestInterrupt()` and cannot abort an
in-flight model call or tool. The safe boundary rechecks the absolute expiry: remote adapters retain
the Postgres row's deadline, while local live delivery uses 24 hours from recipient admission. A
late remote poll therefore cannot restart the clock.

Terminal and graphical presentation removes ANSI, OSC, and other control sequences from peer text
and labels. The original message remains unchanged as untrusted mailbox, transcript, and model
content; presentation sanitization never grants it authority.

## Participant lifecycle

### Local

- listener starts before the participant advertises local reachability;
- title, workspace and activity state refresh the registry record;
- graceful shutdown closes the listener and removes only its instance record;
- a crashed record is removed by the next failed authenticated probe.

### Remote

- registration occurs after MCP capability discovery;
- heartbeats refresh liveness every 30 seconds;
- a heartbeat that reports a missing row triggers re-registration;
- graceful shutdown attempts unregister with a bounded timeout;
- a hard-killed process falls out of the active view after two minutes and is swept after five;
- a failed wake stream is reaped and delivery state remains `poll-fallback` until reconnect.

## Compatibility

- A Brain without registration and heartbeat tools leaves federation disabled without preventing a
  local CLI session from running.
- A Brain or client without wake negotiation continues using inbox polling.
- Existing personal session rows normalize to the personal tenant during migration.
- Existing delivered inbox rows migrate to `applied`; undelivered rows migrate to `pending`.
- Non-text inbox kinds remain durable but are not automatically turned into text steering.

## Troubleshooting

### A session appears remotely but cannot receive

Inspect `lastHeartbeatAt`, not only row presence. A row outside the two-minute active window is stale
and exact delivery rejects it. If the participant is still running, its next heartbeat should
re-register a missing row.

### Local discovery shows an ambiguous key

Two live processes claimed the same exact logical key. Stop the stale participant or start a new
conversation for work that should have a different address. Do not delete arbitrary registry files
while listeners are alive; instance cleanup is ownership-checked.

### A send says persisted-unseen or poll-fallback

The durable row committed, but no matching wake-capable stream confirmed the hint. The recipient's
inbox poll remains the recovery path. Do not resend with a new id merely to force a wake; retry the
same logical id so idempotency returns the original receipt.

### A message is held

The recipient has an `allow` or unknown mutation surface. Holding is expected and belongs to the
recipient. Approval must not be requested from the sender or performed by the transport.

### A queued message expires

The sender receipt becomes `expired`; local hosts also report bounded expiry notices. Remote expiry
means no durable application acknowledgement was recorded before the TTL. A crash can lose that
acknowledgement after transcript append, so expiry proves neither application nor non-application.

## Verification boundary

`npm run test:adr034:acceptance` builds the shared contracts and all four participating packages,
runs focused production CLI/Desktop lifecycle and approval suites, then executes two composite
phases:

1. a Brain-offline adapter-class composition phase with one private temporary home, alongside the
   production HostCore/interaction lifecycle suites; and
2. a two-install-identity phase with isolated homes, two MCP clients, transaction-coupled wakes,
   wake-loss polling, and scratch Postgres.

The full hosted pull-request suite remains mandatory before merge.

The command needs a reachable Postgres admin server. It reads
`BRAINROUTER_TEST_PG_ADMIN_URL`, then `BRAINROUTER_DATABASE_URL`, then `DATABASE_URL`, and otherwise
uses the repository's local Docker Postgres default; every database it creates is uniquely named
and removed during cleanup.

That harness is intentionally same-machine and reproducible. No physical multi-device run is
claimed by the current documentation.
