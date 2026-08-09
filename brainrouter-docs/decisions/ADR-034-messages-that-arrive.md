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

## 5. Open questions

1. **What is the push transport?** SSE was the original plan and the brain already streams. Whether
   the desktop and CLI can share one channel or need two is worth answering before committing.
2. **Where exactly is the interruption point?** D2 needs a boundary the runtime already owns. The
   cancellation path is the obvious candidate and reusing it is probably the whole implementation.
3. **What does a held message look like while it waits?** D5 creates a state — *delivered, awaiting
   your approval* — that has no surface yet in either the CLI or the desktop.
4. **Does a message survive a restart?** It is in Postgres, so mechanically yes. Whether a message
   sent to a session that never comes back should expire, and when, is a retention decision D7 only
   half answers.

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
