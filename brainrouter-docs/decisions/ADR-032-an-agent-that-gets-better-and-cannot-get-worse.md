# ADR-032 — An agent that gets better, and cannot get worse

**Status:** ACCEPTED — approved by the owner for implementation.
**Depends on:** ADR-020 (memory self-improvement), ADR-021 (profiles, capabilities), ADR-029 (the workspace address space, the untrusted-content fence), ADR-031 (one skill library, generated copies).

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
| **No delegation learning** | A repeated sub-task shape never becomes a reusable role. |
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
