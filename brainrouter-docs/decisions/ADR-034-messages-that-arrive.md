# ADR-034 — Messages that arrive

**Status:** PROPOSED — planning only. Nothing here is built.
**Depends on:** ADR-019 (federation, the active-session registry), ADR-027 D12 (bounded queues), ADR-028 (surfaces that tell the truth).

---

## 1. We built most of this, and then stopped one step short

Cross-session messaging is not missing. Three federation stages shipped:

| Stage | What it gave us |
|---|---|
| **2** (0.4.0) | `session_register` / `session_heartbeat` / `active_sessions` — a registry of who is alive |
| **3** (0.4.0) | `session_send`, `session_inbox_read`, `session_inbox_ack` — an inbox with peek-and-ack replay |
| **5** (0.4.2) | `session_delegate_task` — cross-vendor delegation |

Broadcast, pattern fan-out (`<clientKind>:*`), per-recipient ids, a two-minute liveness window, and
atomic delivery marking are all there. This is a good foundation and most of the hard modelling is
done.

**What is missing is the last step: the message reaching someone.**

`federationRegistration.ts:126` says so in its own comment:

> *"Federation Stage 3 (FED-S3-T6) — inbox poller. Pull-only for now; SSE push is deferred to 0.4.1
> per the spec sub-item marked `[-]`."*

That deferral is still open. Everything below follows from it.

### 1.1 The four consequences

- **A five-second poll is the delivery mechanism.** Not fatal on its own, but it means *nothing*
  arrives except by asking.
- **A session that is not running receives nothing.** The message sits in the inbox until that
  session next starts and polls — which may be never. There is no notion of "you have mail" outside
  a live process.
- **A busy session does not hear you.** The poller runs on its own timer; a session mid-turn is not
  interruptible by a message, so "wake a stuck teammate" — the one thing you most want messaging
  for — is exactly what it cannot do.
- **Desktop is not a participant.** `session_register` and the inbox appear only in the CLI's
  federation runtime. The desktop app can neither be addressed nor discover anyone.

---

## 2. What the reference implementation's history teaches

The instructive part of Claude Code's cross-session `SendMessage` is not the feature announcement.
It is that **most of the entries about it are bug fixes**, and they cluster on exactly two themes.

**Delivery honesty** — fixed twice, in 2.1.211 and again in 2.1.222:

> *"Fixed `SendMessage` reporting 'Message sent' when the write to a teammate's inbox had actually
> failed; failed deliveries are now reported as errors."*

**Addressing the wrong session** — three separate fixes: a re-spawned agent reusing a previous
agent's name (2.1.199), background agents spawned by another agent not being found (2.1.212), and a
confirmed remote recipient being swapped for a same-named local session (2.1.221).

> **Both themes are the same failure: the sender is told something happened that did not.** That is
> ADR-028's rule, in a place we have not yet applied it.

Two more worth taking directly:

- **2.1.198** — *"messaging a stuck teammate wakes it to retry immediately"*, and a teammate that
  dies on an API error reports **failed** to the lead rather than going quiet.
- **2.1.224 / 2.1.221** — inbound messages to a session running with bypassed permissions are **held
  for approval**; messages to ordinary sessions auto-deliver. And outbound sends are evaluated by
  the permission classifier **before dispatch**.

---

## 3. Decisions

### D1 · Delivery is pushed; the poll becomes the fallback

Close FED-S3-T6. The recipient learns of a message because it was delivered, not because it asked
at the right moment.

Keep the poll — it is the reconnect path and the answer to a dropped stream — but demote it from
mechanism to safety net. A five-second floor on every interaction is the difference between
messaging and a mailbox you check.

### D2 · A message can WAKE a session, and that is the point

The reason to message another session is usually that it is stuck, looping, or about to do the
wrong thing. A design where it only notices between turns fails precisely then.

> **A session that cannot be interrupted cannot be helped.**

Delivery therefore interrupts at a turn boundary the runtime already owns, the same way a
cancellation does. What it must not do is inject into the middle of a tool call.

### D3 · The sender is told the truth, and "the recipient exists" is part of it

Two failures, distinguished, because they lead somewhere different:

- **not delivered** — the write failed. An error, never "sent".
- **delivered, not yet seen** — it is in the inbox and the recipient has not read it. Also not
  "sent", and not an error either.

`session_send` already returns per-recipient ids and `delivered: rows.length`; the gap is that a
broadcast reaching nobody and a broadcast reaching four peers are both a success today.

### D4 · Address by identity, not by name

The reference implementation fixed misrouting three times. Every one is a name collision: a name is
a label a human chose, and it gets reused the moment a session is re-spawned.

> **A message routes on a session key. A name is for the human, and is resolved to a key at send
> time — with the ambiguity reported rather than guessed.**

Where a name matches two live sessions, the tool refuses and lists them. Where it matches a session
that has since been replaced, it refuses rather than delivering to the impostor.

### D5 · Inbound is a permission boundary, not just a payload

The most consequential decision here, and it is not obvious until you look at what a message can do.

> **A message from another session is an INSTRUCTION arriving from outside this session's trust
> boundary** — and if that session is running with elevated permissions, it is an instruction with
> those permissions behind it.

So: inbound messages to a session with bypassed or elevated permissions are **held for the human**;
ordinary sessions auto-deliver. Outbound sends are classified before dispatch. And the message is
rendered as *from another session*, never as if the user said it.

This is the same reasoning as ADR-029 C4 and ADR-032 D7 — content crossing a boundary does not
inherit the trust of the boundary it arrived at.

### D6 · Every surface participates, or the feature is a CLI feature

Desktop registers, appears in discovery, receives, and can send. Today it does none of these, so a
person working in the app is invisible to their own agents.

Discovery has to answer the question a human actually asks — *which of my sessions are alive, on
which machine, doing what* — rather than list opaque keys.

### D6b · Two transports, one address space — and the backend is not on the local path

Sessions on **one machine** must reach each other **without a round trip to the brain**. Only
crossing devices needs the backend.

| | |
|---|---|
| **Local** — same machine | direct, no backend. Works with the brain unreachable, and with no network at all. |
| **Online** — another device | brain-mediated, the registry we already have |

Two reasons this is a decision and not an optimisation:

1. **Latency and dependency.** The common case is two sessions in one workspace on one laptop.
   Routing that through a server to come back is slower and makes local work depend on a remote
   being up.
2. **It still works offline.** A person on a plane with two sessions open should be able to message
   between them. Requiring the backend for that is a product regression dressed as architecture.

**But the sender must not care.** One address space, one session key, one `session_send`. A router
picks the transport; a session is reachable by exactly one identity whichever path carries it.

> **A session that appears twice — once locally, once through the brain — is D4's name collision
> wearing a transport label.** Discovery merges by session key, and if the same key resolves both
> ways, local wins and the duplicate is not shown.

#### The consequence that matters: where the permission gate lives

D5 holds inbound messages for approval when the recipient runs with elevated permissions. If that
check lived in the backend, **the local transport would skip it entirely** — and the local path is
the common one.

> **The gate belongs to the RECIPIENT, not the transport.** A message is evaluated where it is
> delivered, by the session whose permissions are at stake, on every path.

Same reasoning for D3's honesty and D7's bounds: both are properties of the inbox, so both must hold
whether the message arrived over a socket or over HTTPS.

### D7 · Bounded, like every other queue we own

An inbox is a queue and ADR-027 D12 already settled how we treat those: bounded depth, bounded
retention, and shedding that is **stated** rather than silent. A message dropped for age tells
someone; a message dropped quietly is worse than never sent, because the sender believes it landed.

---

## 4. Out of scope

- **Cross-user messaging.** Same partition rule as everything else: `(org_id, user_id)`. A message
  crossing tenants is a data leak with a friendly name.
- **A general pub/sub bus.** This is session-to-session; anything wider is a different ADR.
- **Replacing delegation.** `session_delegate_task` is a different verb — *do this* rather than
  *know this* — and stays.

---

## 5. Open questions — answered against the code

Each was investigated in our own repository. In every case the answer was already there, which is
the useful finding: this needs assembling more than inventing.

### Q1 · The local transport · **a loopback listener per session, a directory as the registry**

We already have the shape. `packages/core/src/runtime/server.ts` is an HTTP listener with a
versioned prefix (`/runtime/v1`) and a session-key header (`x-brainrouter-runtime-key`), and
`triggers/server.ts` and the provider gateway use the same pattern.

> **Each session opens a loopback listener on an ephemeral port and writes one small file** —
> session key, host id, pid, port — **into a directory under the BrainRouter home. That directory
> IS local discovery.**

Why not the alternatives:

| | |
|---|---|
| a per-user broker daemon | a background process nobody asked to run, that has to be started, supervised and killed. §5's own constraint refuses it. |
| a watched directory of message files | works, and makes every message a filesystem event with no delivery confirmation and no back-pressure — it re-creates D3's dishonesty in a new place. |
| the existing Electron IPC | desktop-only. A CLI cannot join, so D6 fails by construction. |

Liveness is the port answering, not a heartbeat: a session that died leaves a stale file whose port
refuses a connection, and the reader reaps it. **That is strictly better than the two-minute
heartbeat window** the remote path uses, because it is a fact rather than an inference.

### Q2 · The remote transport · **the MCP stream that already exists**

`brainrouter/src/index.ts:335` — *"MCP endpoint — handles POST (requests) and GET (SSE stream)"*.
The brain already speaks Streamable HTTP with SSE, and every session is already an MCP client of it.

So the remote push is a **server-initiated MCP notification on the channel the session is already
holding open**. No second channel, no new auth, no new reconnect logic — and it inherits the
Accept-header promotion already built for naive clients.

### Q3 · Deciding which transport applies · **`stableDeviceId`, not a hostname**

`packages/core/src/sync/deviceId.ts` already provides *"a stable per-install device id, shared by
every offline-first surface"*, persisted and deliberately non-drifting because HLC ordering depends
on it — *"a device that silently changes its id looks like a NEW peer to the merge rules."*

Same `deviceId` means same machine, so the router uses local. A hostname would have been the obvious
choice and the wrong one: hostnames collide, change on network moves, and are attacker-suppliable in
some setups.

**Reusing it also means the registry gains nothing new to keep correct** — the id is already
maintained for the sync stack.

### Q4 · The interruption point · **the cooperative turn interrupt, already built**

`agent.ts:796-806` has exactly what D2 needs and it is documented as such:

> *"cooperative turn interrupt … checked at every LLM-call and tool boundary so a long multi-tool
> turn stops at the next seam instead of running to completion"* — plus `turnAbort`, whose signal is
> threaded into LLM calls and tools.

**Delivery raises the same cooperative flag the Stop button and Esc raise**, and the message is
presented at the next seam. It must NOT abort `turnAbort` — that is the *stop* gesture, and a
message is an interruption, not a cancellation. Getting those two confused would make every incoming
message kill the work it was trying to correct.

### Q5 · The held-message surface · **the MCP approval path**

`packages/core/src/agent/guards/mcpApproval.ts` already routes approval requests through a typed
guardian path, with a classifier that treats `send`-shaped verbs as requiring approval.

A held message is the same shape: something arrived, it needs a human yes, and both surfaces already
know how to draw that. **Adding a second approval concept for messages would give us two places to
get consent wrong.**

### Q6 · Retention · **age-based shedding with a loud notice, exactly as ADR-028 D2 does it**

`packages/core/src/sync/outbox.ts` already settled this for the planner: `MAX_OUTBOX_AGE_MS` of 30
days, a `shed()` pass, and — the important part — `shedNotice`, *"set when shedding dropped
operations, so the UI can say so."*

An inbox gets the same treatment and the same bound. A message that expires unread tells someone; a
message that vanishes quietly is worse than one never sent, because the sender believes it landed.

**The one thing to decide fresh:** 30 days is right for a planner operation and probably too long
for a message to a session that never came back. A shorter default belongs here, and the notice
matters more than the number.

---

## 6. How this will be judged

**Two sessions, one stuck.**

Start a session on a long or looping task. From another session — on the same machine or a
different one — send it a correction. The test is:

1. it **arrives while the task is running**, not after it finishes (D1, D2);
2. the sender is told whether it **actually landed** (D3);
3. sending to a re-spawned same-named session **refuses** rather than misroutes (D4);
4. the same message to a session running with elevated permissions **waits for the human** (D5);
5. and all of it works with the **desktop** on either end (D6).

Today, one through five all fail. Step 2 is the one that would embarrass us most: we would report
success.

**Then run the whole thing twice more**, because D6b says the transport must not change the answer:

6. **both sessions on one machine, with the brain stopped.** Every step above still passes. If
   messaging needs a server to reach the next window, D6b was not implemented.
7. **the two sessions on different devices.** Same behaviour, same wording, same approval prompt —
   and the elevated-permission hold in step 4 still fires, because the gate lives in the recipient
   rather than in whatever carried the message.
