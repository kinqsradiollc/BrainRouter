# ADR-032 — An agent that gets better, and cannot get worse

**Status:** ACCEPTED — approved by the owner for implementation.

**Implementation status (2026-08-12): COMPLETE IN CODE. What remains is one acceptance run, not a
build.**

The deterministic half is demonstrated, not asserted: 82 tests in
`packages/core/src/tests/learning-adr032.test.ts`, including the §6 exercise driven through real
Agents — one learns from its own repetition, a second runs what it learned, a third cannot once it
is retired.

Three gaps found by a 2026-08-11 audit are **all closed by WITHDRAWAL**, because building them meant
inventing product:

- **D3 on hosted chat** — hosted hardcoded `form: "lesson"`, so a PROCEDURE (the form that changes
  what the agent DOES) could never persist there while local, CLI and Desktop could learn one. The
  gate now takes the host's capabilities and REFUSES a procedure by name, with its own counter that
  reaches an operator, instead of silently downgrading it to a lesson. A silent downgrade and an
  explicit refusal are different promises.
- **D5 on hosted chat** — hosted has one checkpoint where the others have three, and now says so:
  there is no compaction event on a stateless endpoint, and a session-end sweep would be a new
  retention surface for user conversation content. A future `session-end` enqueue fails closed at
  the schema, which this document claimed and nothing tested until it did.
- **The `delegation` form is withdrawn from D3 entirely.** It returned `non-executable`
  unconditionally — an honest refusal, but a branch nobody could reach. It is gone from the union,
  from the gate, from the reflection prompt, and from every schema that enumerated it, including the
  SQL `IN (...)` list. No migration was needed: no row could ever have carried it.

**NOT done:** the live-model §6 acceptance run is still unrecorded, and command-based local
procedures still carry no separate runtime-owned ledger of the exact successful actions they may
replay.
**Depends on:** ADR-020 (memory self-improvement), ADR-021 (profiles, capabilities), ADR-029 (the workspace address space, the untrusted-content fence), ADR-031 (one skill library, generated copies).
**§6 acceptance (2026-08-10):** The full-Agent A/B/C exercise §6 asks for now exists
(`packages/core/src/tests/learning-adr032.test.ts`) and passes. Four separately constructed Agents,
driven through `runTurn` with only the model's OUTPUT stubbed: A repeats a failing read and its own
turn finalizer schedules the checkpoint — nothing in the test calls it; B is handed the lesson by its
own context preparation and loads the promoted procedure through `get_skill`, resolving locally
rather than from a server; R observes the falsifier (the file exists now, so the read succeeds) and
retires the lesson on its own; C can neither be told the statement nor resolve the skill. The
trajectory, gate, store, skill writer, central-pointer lifecycle and tool ceiling are all shipping
code, and the stub quotes its evidence out of the REAL reflection prompt, so an unquotable citation
is refused by the gate rather than waved through. Mutation-checked: disabling `applyLearnedContext`
fails it with "a new agent was never handed what the last one learned".

This closes §6 steps 1–4 deterministically. It is NOT the live-model exercise §6 also asks for; that
remains outstanding and needs an owner-approved run.

**Implementation status (2026-08-12):** PARTIAL — local, CLI, Desktop and hosted chat now have
tenant-pinned learning, explicit human-correction ingress, reversible central/device governance,
and bounded automatic checkpoints. Hosted reflection is admitted and enqueued atomically through
Postgres with per-session and per-user-plus-org budgets, then executed by an internal worker.

Three things this ADR used to leave pending are now **withdrawn rather than deferred**, because each
was a promise with no owner and a branch no execution could reach (see D3 and D5):

- **learned delegation is gone from the model**, not fail-closed. `LearnedForm` is
  `lesson | procedure`;
- **procedure learning is withdrawn from hosted chat.** The gate is told what the host can execute
  and refuses a procedure there by name (`no-execution-port`), counted separately in the job result
  instead of being filed as a "lesson";
- **hosted D5 is turn-end, and that is the whole of it.** There is no compaction event and no
  session-end signal on a stateless chat endpoint to hook one to.

What remains genuinely incomplete: command-based local procedures do not yet carry a separate
runtime-owned ledger of the exact successful actions they may need. Deterministic and real-Postgres
tests exercise the lifecycle, but neither a fresh full-Agent repeated-mistake exercise nor a
qualifying live-model acceptance run has been recorded.

---

## 1. Where we actually are

ADR-020 shipped four phases and they work: structured session reflection writes six typed
categories (`mistakes`, `anti-patterns`, `lessons`, `decisions`, `preferences`,
`reusableWorkflows`), skill reliability is tracked, memories consolidate, and confidence promotes.

So the agent **remembers**. What it does not do is **change how it works**.

Six gaps, each verified against the code rather than assumed:

| | |
|---|---|
| **Procedure is prose** | A `reusableWorkflow` is a description the model re-reads and re-interprets every turn. Nothing it learns ever becomes something that *runs*. |
| **No behavioural persistence** | Nothing writes supplemental instruction. A correction survives as a memory the model may or may not weight. |
| **No delegation learning** | A repeated sub-task shape never becomes a reusable role. **Withdrawn in D3** — this gap is real and we are not closing it. |
| **Nothing decides whether to learn** | `reflectSession` stores what it extracts. There is no gate. |
| **No rollback** | `grep rollback` over `memory/` hits only SQL migrations. A bad lesson has no defined way out. |
| **Learning is opt-in and manual** | `memory_reflect_session` is an MCP tool the agent must choose to call. There is no turn-end, session-end, or compaction trigger. |

The last one is the worst, and it is worth saying plainly:

> **An agent learns only when it remembers to ask — which is exactly what a struggling agent will
> not do.** The sessions with the most to teach us are the ones least likely to reflect.

---

## 2. The principle this ADR is built on

An agent that can edit itself can degrade itself. Every decision below exists to make one direction
cheap and the other expensive:

> **A change to how the agent behaves must be reversible, attributable, and falsifiable.**
> Reversible — there is a defined way back. Attributable — we can say which session produced it and
> from what. Falsifiable — it states what would show it wrong, and something checks.

Anything that cannot satisfy all three is not learned; it is remembered, which is what we already do.

---

## 3. Decisions

### D1 · Learned state is EVIDENCE, except where a human corrected us

The tempting move is supplemental prompt notes the model treats as instruction. I am refusing that
as the default, because our system prompt is assembled from **declared, reviewable sources** — the
profile, the persona, the capabilities, `brainrouter-rules/`. The moment a session can write into
that assembly, "why did it do that?" stops being answerable from the manifest.

So provenance decides weight, and there are exactly two tiers:

| Origin | Enters as | Why |
|---|---|---|
| **The model inferred it** from a trajectory | **evidence**, labelled and dated, alongside memory | An inference is a hypothesis. It informs; it does not command. |
| **A human corrected us** — explicit, in the session | **instruction**, in a supplemental layer | Someone with authority said it. Demoting that to a hint is how the same correction gets given four times. |

Both tiers are visible, both carry provenance, and neither touches the base prompt.

### D2 · A gate, and the price of admission is falsifiability

Nothing is learned by default. A candidate must pass a reviewer whose bar is stated rather than
vibed — reject one-off noise, transient tool output, and unsupported hypotheses.

Beyond that, one requirement of our own:

> **A candidate lesson must name what would show it wrong.**

"Prefer `rg` over `grep`" is admissible; it fails visibly when `rg` is absent. "Be more careful" is
not — nothing could ever contradict it, so it can never be retired, and an unfalsifiable lesson is a
permanent resident.

### D3 · A repeated procedure becomes something that RUNS — and it cannot live in the library

This is the largest behavioural win and it collides directly with ADR-031, which is why it needs
deciding rather than assuming.

**ADR-031 made `skills/` a single source with generated, gitignored copies.** A learned skill
therefore *cannot* be written there: the copy is regenerated on every build, so the lesson would
vanish, and if it were written to the source it would ship to every user of the product.

> **Learned skills live in a user-scoped store, loaded beside the library and never merged into it.**

Consequences to accept deliberately:

- the loader gains a second, clearly-labelled origin — a person must always be able to tell a shipped
  skill from one their agent wrote;
- promotion from learned → library is a **human action**, a pull request, not a threshold. A skill
  that reaches everyone is a product decision;
- ADR-031's byte-for-byte drift check keeps applying to the library and must **not** be extended to
  the learned store, or every learned skill fails the build.

#### What D3 does NOT cover, decided rather than deferred

**Learned delegation is withdrawn.** §1 listed "a repeated sub-task shape never becomes a reusable
role" as a gap, and it is one. Closing it needs a constrained child-authority port that can prove a
narrower ceiling at spawn time and re-prove it every time the role is reused — a capability nobody
is building, and one this ADR is in no position to promise. It was carried for a while as a
`delegation` form the gate refused unconditionally, which is worse than absence: the union advertised
a capability, the refusal read as temporary, and the promotion branch behind it was unreachable code.
The form is removed. If the port is ever built, the form comes back with it.

**Procedure learning is withdrawn from hosted chat.** `POST /api/brain/chat` is a model call and
nothing else — no tool loop, no skill loader, no activation — so a learned procedure there could only
be stored as prose that claims to run, which is exactly §1's first gap wearing a fix's clothes.
Rather than persist it under a quieter label, the gate is told what the host can execute and refuses
a procedure by name: rule `no-execution-port`, a reason that says which port is missing, and its own
counter in the checkpoint's result so an operator can see a withdrawn capability being exercised
instead of reading it as ordinary gate noise. Local, CLI and Desktop are unaffected; they have the
port, so they still learn procedures that run.

> A procedure hosted chat cannot run is not a lesson. Filing it as one is how the store fills with
> statements that describe a behaviour nothing performs.

### D4 · Every learned item is reversible, and carries where it came from

A learned item records the session, the trajectory evidence, the gate's reasoning, and a stable id.
Undoing one is a first-class operation, not a database edit.

**The reason this is not optional:** D6 will retire things automatically. A system that can delete
what it learned needs an audit trail more than a system that only appends.

### D5 · Learning is automatic, bounded, and never blocks a turn

A checkpoint at turn end, at compaction, and at session end — because §1's worst gap is that the
agent must remember to ask.

Two constraints:

- **it runs after the turn, never inside it.** A person waiting on an answer must not wait on
  reflection;
- **it is bounded per session.** Reflection is an LLM call; unbounded, it is a cost leak that scales
  with how badly a session is going.

#### Hosted has one of those three checkpoints, and that is the decision

Local, CLI and Desktop fire at all three moments. **Hosted chat reflects at turn end only.** Not as
a shortfall to be filled later — the other two moments do not occur on that surface:

- **there is no compaction.** `POST /api/brain/chat` receives the history from the client on every
  request and never compacts it, so there is no event to hook a checkpoint to;
- **there is no session end.** The server is never told a hosted conversation finished; a browser
  simply stops posting. The only way to detect one is an idle timer, and that means keeping a copy
  of the conversation on the server past the turn that needed it, so a sweep can reflect on it
  minutes later. That is a new retention surface for user conversation content, bought for a
  marginal gain over a checkpoint that already runs after **every** completed turn under the same
  budgets.

The exchange is deliberate: hosted trades the whole-session view for reflecting on every turn.
`HOSTED_LEARNING_CHECKPOINT_REASON` states it once, and the durable job schema validates the same
constant at the far end of the queue, so a future session-end enqueue fails closed rather than
arriving as an unhandled reason.

### D6 · Measure whether it helped, and retire what did not

Neither our system nor the reference implementation does this. Theirs records an `expectedOutcome`
and never checks it. **Ours does not even record one.** This is the decision that makes the
difference between a ratchet and a drift, and it is where we should be better rather than equal.

Each learned item states what should improve. The system then tracks the obvious signal — was it
retrieved, and did the thing it predicted actually happen — and **demotes what never pays off**,
back down the same ladder it climbed.

> A store that only grows becomes noise, and noise is indistinguishable from having learned nothing.

### D7 · Learning from untrusted content is an injection that PERSISTS

The one genuinely new risk, and it does not exist in the read-only case ADR-029 C4 already handles.

A PDF, a fetched page, a mirrored issue title, a synced note — all attacker-influenced, all now
reaching a reflection step that decides what the agent should believe next time.

> **An injection that is merely read affects one turn. An injection that is LEARNED affects every
> future session, and it arrives already trusted.**

So:

1. Untrusted content stays fenced through the reflection step — the reflector reads it as data, the
   way the turn does.
2. **A lesson may not be derived solely from untrusted content.** Something the agent or the person
   did has to corroborate it.
3. The instruction tier (D1) is reachable **only** by a human correction in-session — never by
   anything a document said, however imperative its phrasing.

### D8 · Same partition as everything else

Learned state is `(org_id, user_id)`-scoped like memory, notes and the planner. No new tenancy shape.

**No cross-tenant learning, at all.** A lesson learned in one customer's workspace reaching another
is a data-leak with a pleasant name, and it is the kind of feature that is easy to add later and
impossible to take back.

---

## 4. Out of scope

- **Weight updates / fine-tuning.** Different product, different infrastructure.
- **Editing the base system prompt.** D1 explains why; the assembled prompt has to stay explicable.
- **Automatic promotion into the shipped library.** D3 makes that a pull request.
- **Learning across tenants.** D8.

---

## 5. Open questions

1. **Where does the checkpoint run for the hosted product?** Reflection is an LLM call, so per-tenant
   cost and the bounded-queue treatment ADR-027 D12 gave other work both apply. Desktop can reflect
   locally; hosted has a budget question that should be answered before this ships.
2. **What is the retirement signal, concretely?** "Was it retrieved" is easy and weak. "Did the
   predicted improvement happen" is right and hard. A first cut might be: retrieved-and-not-
   contradicted survives, never-retrieved decays, contradicted retires immediately — but that is a
   guess and D6 deserves better than a guess.
3. **Does a learned skill need the tool allowlist?** There is already pending work on per-skill
   allowed-tools. A skill the *agent wrote* is exactly where that matters most, and these two should
   probably land together rather than in either order.
4. **How does a person see and edit this?** A learned store nobody can inspect is a black box that
   changes behaviour — the thing ADR-028 exists to refuse. Desktop and dashboard surfaces are
   in scope for the work even though this ADR does not design them.

### 5.1 What the implementation settled

1. **Hosted execution uses the durable queue, not a server filesystem.** After a completed hosted
   chat turn, a bounded/redacted trajectory is atomically admitted with its durable job under
   per-session and per-user-plus-org daily model-call ceilings. An internal executor resolves the
   exact active-org reflection model, admits only falsifiable evidence-tier lessons, applies
   outcomes only to the exact items delivered to that turn, and rotates a persistent bounded cursor
   across retirement candidates. Hosted chat has no tool/procedure activation port, and D3 now
   withdraws procedure learning there rather than holding it open: the gate refuses it as
   `no-execution-port` and the checkpoint reports that refusal on its own counter.
2. **Retirement has an explicit first policy.** One observed falsifier retires immediately; five
   retrievals without a confirmed outcome demote an item; an unused item demotes after 30 days and
   retires on a later sweep if it remains unused. Re-deriving the same statement is not a
   confirmation. These values are policy constants, not an empirical claim, and should be tuned
   from outcome data.
3. **A learned procedure has a tool ceiling.** It begins with a read-only baseline and may add only
   exact, observed safe edit tools. Shell and terminal execution never carry forward. Activation
   refreshes the model-visible schema, and every later authorization revalidates the linked learned
   item so a concurrent revert, demotion or retirement disables it.
4. **The two truthful views and correction actions are explicit.** Desktop shows and reverts the
   device ledger; the hosted dashboard shows and reverts only authenticated user-plus-active-org
   central records. Both provide a structured statement/falsifier/expectation action for a human
   correction; ordinary conversation cannot mint instruction-tier state. Reason-required reversals
   are audited, central records are archived, and host lifecycle reconciliation is authorized
   outside the model-callable tool surface.

---

## 6. How this will be judged

Not by whether reflection runs. It runs today.

**The test is a repeated mistake.** Make the agent fail the same way three times in one session —
the same wrong command, the same missing step. Then:

1. it should learn something **without being asked** (D5);
2. that something should be **falsifiable** (D2) and, if it is a procedure, should **run** rather
   than be re-derived (D3);
3. a new session should not repeat the mistake;
4. and when the lesson stops applying — the tool changes, the project moves on — it should **retire
   on its own** (D6).

Steps 1 to 3 are table stakes; the reference implementation does them. **Step 4 is the one worth
building**, because it is the difference between an agent that gets better and one that merely
accumulates.

The deterministic tests inject checkpoint model output, resolve the resulting procedure
through the learned-skill loader, inject a later contradiction, and verify that retirement removes
the procedure from activation. A separate live-turn test verifies that activating a learned skill
immediately narrows the model-visible tool schema and later authorization. Hosted tests additionally
exercise durable admission/idempotency, exact-org execution, retrieval/outcome accounting and
automatic retirement against a real Postgres database. These are repeatable component and
integration evidence, but they do not instantiate a fresh full Agent that observes and avoids the
repeated mistake, and they are not a substitute for the live exercise above.
