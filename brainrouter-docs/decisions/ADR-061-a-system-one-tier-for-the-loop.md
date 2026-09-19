# ADR-061 — A System One tier for the loop

**Status:** Proposed (2026-09-19). Nothing in this ADR is built. Delivery board in §5.

**Depends on:** ADR-041 (plug-and-play runtime — registries, ports, the D8 handler
pipeline), ADR-059 (the turn path — runtime-emitted steps a surface can show), the tool
authorization phase (`packages/core/src/agent/runtime/toolAuthorizationPhase.ts`), the shell
classifier (`packages/core/src/exec/policy/shellClassifier.ts`), the briefing trigger
(`packages/core/src/memory/briefingTriggers.ts`), the routing resolver
(`packages/core/src/provider/routing/resolve.ts`), and the two redaction chokepoints —
`redactText` in `packages/core/src/session/transcript/sessionStore.ts` (what a transcript
gets) and `redactSensitiveMemoryText` in `brainrouter/src/memory/util/redaction.ts` (what the
brain stores). Every string that leaves the machine passes one of them.

---

## 1. Where we are

An agent loop is an LLM deciding what to do, a tool running, and the loop continuing. Around
that loop sit the decisions the loop itself does not make well: which model should take this
turn, is this tool call safe, would memory help here, is the task actually finished, is this
turn making progress. Each is a small, structured question with a short answer.

BrainRouter answers every one of them today. A census of the loop, against `release/0.4.22`:

| Decision | Where | How it is decided |
|---|---|---|
| Which model takes the turn | `provider/routing/resolve.ts` | `auto` resolves to a **static ordered chain** from config, optionally sorted free-first. The request is never read. |
| Is this shell command safe | `exec/policy/shellClassifier.ts` | Three lexical rules in order: strict allowlist, the destructive-command guard, a "dangerous" pattern list. Outcome allow / ask / deny — but from a rule hit. |
| Does this MCP tool need approval | `agent/guards/mcpApproval.ts` | Annotation flags; anything not provably read-only asks. |
| Is this tool mutating | `exec/policy/execPolicy.ts` | A static `actionKind` per tool name. |
| Would memory help this turn | `memory/briefingTriggers.ts` | `countEntityTokens ≥ 2`: file-path and identifier regexes plus mid-sentence capitalised words, and cue regexes. |
| Did the turn end on a deferral | `agent/guards/deliverableCheck.ts` | Tail regexes. |
| Did we verify what we wrote | `agent/guards/verificationGate.ts` | A boolean over this turn's tool names. |
| Is the task done | `agent/guards/turnBudget.ts` | After each window of tool calls, the **same model that is working** is asked to assess itself. |
| Is this turn making progress | `taskTrackingNudge`, preamble guard, steering receipts | Counters and thresholds. |
| Is this call a repeat | `agent/guards/repeatGuard.ts` | Exact signature in a batch window; a byte-identical result digest across turns. |

Ten decision sites. Nine are rules — free, instant, and blind to anything they were not
written to see. One asks the expensive model, which is the least reliable grader of its own
progress precisely when it is stuck. None carries a confidence. None can say *"I am not sure,
ask."*

The consequences are on record in this repository:

- The shell classifier is good at DESTRUCTION and blind to PUBLICATION. **This bullet was
  wrong when this ADR was written and is corrected here rather than quietly fixed:** it
  claimed `find . -delete` slipped through. It does not — that and `aws s3 rm --recursive`
  are both caught by the dangerous heuristic, as a test in the S1/S2 slice now asserts. What
  the wordlist has no entry for is the other kind of irreversible: `npm publish`,
  `terraform apply -auto-approve` and `gh release create` are all classified safe, and so
  will the next deploy verb nobody wrote down be. The three-way outcome exists; the middle is
  unreachable except by a rule hit.
- The recall gate scored *"tell me about the current state of Orbyn"* at one proper noun,
  under its threshold of two. The question it is a proxy for — *would recalled memory help
  here?* — was never asked.
- The turn-budget checkpoint injected three self-assessments into a session that read the same
  three files forty-three times (#1724). The model reported progress each time. The runtime had
  recorded the denial that was driving the loop in `recent-denials.json`; nothing consulted it.
- Routing's only adaptive signal is `isStrongModelFamily`, a regular expression over the model's
  *name*, and it is used to clamp loop caps, not to choose. "Use the cheapest model that can do
  this" is a sentence our configuration cannot express.

The reference point is LangChain's harness around TypeSafe's **Jev**, a *System One* model:
it never generates text; it answers named, typed questions — `noul` (a probability that a
statement is true), `choice` (a distribution over ≤255 options plus a confidence), `score`
(ordered levels) — over a `state` payload, every question in a request evaluated in parallel,
in 70–500 ms, trained so that higher stated confidence corresponds to higher accuracy. Their
integration is two middlewares: a `choice` before the model call to pick the model, a `noul`
around each tool call to block risky ones. The pattern their documentation is really
recommending is quieter than either: classify once, early, cheaply; write the answer into
agent state; let everything downstream read it.

We have the plumbing that pattern plugs into and they do not — approval prompts, a fail-closed
mode for unattended sessions, denial recording, repeat and unchanged-result guards, result
handoff, per-workspace tool profiles. What we lack is the tier itself.

## 2. The idea

> **Between "a rule said so" and "ask the expensive model" there is a third rung: a fast,
> calibrated, typed answer. Put one port on that rung, make the existing rules its zero-cost
> default provider, and move the loop's decisions onto it one at a time — the ones we have
> already been bitten by first.**

The port is the decision. Which model answers it is a provider choice, as everything else in
this codebase is. The loop's behaviour does not change until a knob does.

## 3. Decisions

### D1 · One port, three primitives, no text

`packages/core/src/decision/` gains a `DecisionPort`:

```ts
interface DecisionPort {
  ask(state: DecisionState, questions: Record<string, DecisionQuestion>): Promise<DecisionAnswers>;
}
type DecisionQuestion =
  | { kind: 'noul';   instructions: string }
  | { kind: 'choice'; instructions: string; options: Record<string, string> }   // key → criteria
  | { kind: 'score';  instructions: string; levels: string[] };                 // ordered
interface DecisionAnswer {
  kind: 'noul' | 'choice' | 'score';
  value: number | string;            // probability, chosen key, or level
  probabilities?: Record<string, number>;
  confidence?: number;               // absent when the provider cannot state one
  provider: string;                  // 'rules' | 'jev' | 'local' | …
  latencyMs: number;
}
```

`DecisionState` is text, structured data, or a bounded slice of the turn's messages — the same
three shapes the reference accepts. The port **cannot return a string it was not handed**: a
`choice` returns one of the keys it was given, a `score` one of the levels. This is the property
that makes the tier safe to wire into gates — it can be wrong, but it cannot be creative.

The interface and its types live on a browser-safe entrypoint so both hosts and the CLI reach
one copy. Providers are node-side.

### D2 · The rules are the floor, and the first provider

Every decision site keeps its rules. A hard deny stays a hard deny whatever the port says; the
allowlist, the destructive-command guard and the dangerous-pattern list are not replaced, they
are *below* the port. The port decides only what the rules leave undecided — and in the shell
gate that is exactly the band between "clearly safe" and "clearly not," which today collapses
to whichever side the last rule happened to fall on.

The first provider is `rules`: it answers each consumer's question with the outcome the
existing heuristic already produces, at confidence `1.0` or `0.0`, in microseconds. With the
port set to `rules` — the default — every site behaves byte-for-byte as it does now. This is
what lets the port land before any model does, with tests that pin the equivalence.

### D3 · Consumers, in the order they have cost us

Each consumer owns its thresholds in `cli.decisions.<consumer>` and keeps its current code path
when the port is off.

1. **Shell risk** (`shellClassifier.ts`). After the rule floor, one `noul` over the command,
   its arguments, and the user's last message: *"Is this command too risky or insufficiently
   authorized for what the user asked?"* Probability drives the three-way outcome the classifier
   already has: below `ask.low` → allow, above `ask.high` → deny, between → **ask**. Silent
   sessions stay fail-closed: the *ask* band denies, as it does today. This is first because a
   wrong answer here costs the most and because the *ask* path already exists.
2. **Recall gate** (`briefingTriggers.ts`). One `noul` — *"Would previously captured memory
   about this workspace help answer this?"* — thresholded per `recallMode`. The entity-token
   count remains as the `rules` provider's answer. The briefing's cost was the reason for the
   heuristic; the classifier saves the same tokens without counting capital letters.
3. **Route choice** (`resolve.ts`). When the request is `auto`, one `choice` over the resolved
   chain, each route's criteria derived from what the registry already knows — cost, `free`,
   `local`, context window, tool support — with the instruction *"the least costly route that
   can complete this task safely."* Once per turn, never per model call. The chain order remains
   the fallback order; the port only picks where to *start*. The always-on router's contract
   (ADR-041; explicit picks need `withFallbacks: false`) is unchanged.
4. **Turn checkpoint** (`turnBudget.ts`). One `score` over the last window's tool results —
   *progress: none / some / substantial* — answered by the port, not by the model being
   judged. `none` short-circuits to the corrective prompt with the recorded denials attached;
   this is the change that would have named the denied `extract_result` on the first
   checkpoint rather than never.

The deferral, verification, mutating-ness and repeat rules stay rules. They are deterministic
questions with deterministic answers; a probability adds nothing to "did a build command run."

### D4 · What leaves the machine, and when

A provider that is not local sends state to a third party. Three rules, none optional:

- Every `DecisionState` passes the existing redaction chokepoint before any provider sees it.
  Tool arguments are the sharpest case — the reference's own docs say *"don't pass secrets in
  tool arguments unless transmission is acceptable"* — so the shell consumer sends the command
  with the same redaction a transcript gets, never raw.
- State is bounded per call (`cli.decisions.maxStateChars`, default 8 KB). A question about a
  tool call does not need the session.
- The port is **off by default**; enabling a remote provider is a per-workspace opt-in in
  `config.json` under `cli.decisions`, never an environment variable
  ([`brainrouter-rules/` on knobs](../../brainrouter-rules/README.md)). Managed installs can pin
  it off.

### D5 · Every decision is recorded, with its probability

The lesson of #1724–#1727 was that the runtime had the evidence and nothing surfaced it. Each
answer the port gives is appended to the session's `recent-decisions.json` beside
`recent-denials.json`: consumer, question, provider, probability, threshold, outcome,
latency. The turn path (ADR-059) emits a `decision` step so the desktop and the CLI can show
*why* a command asked, a model was chosen, or memory was skipped — and so a wrong decision is
diagnosable from the session directory rather than from a pasted trace.

### D6 · Providers are providers

`rules` (default), `jev` (TypeSafe's HTTP API, through the existing provider-credential path),
and `local` (a small classifier-capable model already in the registry, asked with a strict
schema). A decision call never enters the LLM fallback chain: if the configured provider fails,
the answer is the `rules` answer with `provider: 'rules'` and a recorded fallback, not a retry
against a frontier model. A System One question must never cost a System Two call.

### D7 · Calibration is verified, not trusted

A stated confidence is only useful if it tracks accuracy. Recorded decisions plus their
eventual outcomes (the user approved, the command ran clean, the recalled records were cited)
form a held-out set; a provider whose confidence does not track accuracy on it is demoted to
**advisory** — its answers are recorded and shown, and the rules decide. Calibration is a
measured property of a provider in *this* deployment, not a claim on a vendor's page.

### Alternatives rejected

- **Ask the frontier model a structured question at each site.** It answers; slowly, at
  full price, and with the overconfidence the checkpoint already suffers from. Every site that
  matters runs per tool call; seconds and dollars per gate is the cost the tier exists to avoid.
- **Write more rules.** This is what the census shows we have been doing. Each rule is right
  about the case that produced it and silent about the next one; a rule cannot say "unsure."
- **Bring back an LLM judge.** The recall relevance judge was removed (migration 029) because it
  was slow and no more accurate than the heuristic it replaced. This ADR does not propose a
  judge; it proposes a *classifier* with a measured calibration and a rules floor beneath it.
- **Integrate the vendor directly, without the port.** Ties four loop sites to one HTTP API
  and one company. The port costs one interface and buys the ability to answer the same
  questions locally.

## 4. What this does not do

- It does not replace approval. A human "ask" remains the resolution for the uncertain band;
  the port makes that band reachable, it does not remove it.
- It does not route per model call, or mid-turn. Once per turn, like the reference.
- It does not send memory content to a third party by default, and never unredacted.
- It does not generate anything. A port that can return free text is a different design and
  is out of scope by construction (D1).
- It does not touch the deterministic guards. Repeat detection, verification, mutating-ness
  and deferral stay rules.

## 5. Dependency-ordered delivery board

| # | Slice | Scope | Proves |
|---|---|---|---|
| S1+S2 | The port, the floor, and the shell gate | `packages/core/src/decision/` — types, `DecisionPort`, the `rules` provider, `recent-decisions.json` + `/recent-decisions`, the ADR-059 `decision` step — **plus** the shell consumer above the lexical floor, `cli.decisions.shell.{low,high}`, and the equivalence test that pins byte-for-byte behaviour on `rules`. | D1, D2, D3.1, D5 |
| S3 | Recall gate | `briefingTriggers.ts` consumes the port; entity count becomes the `rules` answer | D3.2 |
| S4 | The `jev` provider | HTTP client through the credential path; redaction + size bound on every state; fallback to `rules` recorded | D4, D6 |
| S5 | Route choice | one `choice` re-heads the chain an `auto` request resolved to; explicit picks untouched, `resolve.ts` untouched | D3.3 |
| S6 | Turn checkpoint | `turnBudget.ts` scores progress by the port and attaches recorded denials to the corrective prompt | D3.4 |
| S7 | Calibration | held-out eval from recorded decisions and outcomes; advisory demotion | D7 |
| S8 | Docs | configuration.md `cli.decisions`, a guide, STATUS row | — |

**S1 and S2 merged into one slice during the build, and the reason belongs here:** the
repository's own inert-value sweep fails a module with no non-test importer, so a port with
"no consumer wired" is not a shippable PR in this codebase — it is a build break. Shipping the
port *with* its first consumer satisfies the sweep and costs nothing, because the consumer on
the `rules` provider is a no-op. The same rule is why `/recent-decisions` ships in the first
slice rather than later: a recorder nobody reads is a dead export.

**S5 sits beside `resolve.ts`, not inside it, and the reason is the same kind of
constraint.** The board first read *"`resolve.ts` picks the chain's starting route"*, but
that resolver is pure and synchronous and is called from eight places, most of them
resolving an explicit model. Making it `async` to ask a question that only `auto` needs
would push a promise into every one of those callers to change the behaviour of one. So the
choice lives in `routeDecision.ts` and runs on the array the resolver returned — the resolver
stays pure, the promotion is one re-head with every other route in its configured order, and
the always-on router's contract (explicit picks need `withFallbacks: false`) is untouched by
construction, because an explicit pick never reaches the port.

Its consumer is the gateway, which is the only place in the product where `auto` is a live
request: everywhere else the model is an explicit pick the user made. A gateway is not a
session, so its decisions have no `recent-decisions.json` to append to; D5's record is the
server log, which both hosts already own, and which stays silent on `rules` because the chain
head is then the answer by definition.

The combined slice still changes nothing for anyone. S3 is a day and retires another heuristic
this repository has been bitten by. S4 is the first slice that sends a byte anywhere.
Each slice is its own PR into the release branch with the focused checks; S2 additionally runs
the destructive-command and approval-guard suites, because it sits beneath them.

## 6. How this will be judged

> Replay the session from #1724 — the one that read `AGENT.md` forty-three times — with the
> port on `rules`, then with a calibrated provider.

- With `rules`, every gate produces exactly what `release/0.4.22` produced, and
  `recent-decisions.json` says so at confidence 1.0.
- With a provider: `npm publish` during a turn the user asked to *fix a typo* is **asked**,
  not run; `git status` is not, and `rm -rf /` is still refused by the floor before the tier
  is consulted at all. *"Tell me about the current state of Orbyn"* fires recall. A
  lookup goes to the cheapest route that supports tools; a root-cause question does not. And
  the turn checkpoint says **no progress** by the second window, with the denied
  `extract_result` in the corrective prompt — the sentence that would have ended that session
  an hour earlier.
- Every one of those outcomes is readable from the session directory, with the probability
  that produced it.
