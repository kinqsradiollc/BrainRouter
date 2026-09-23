# The decision tier

Your agent makes a lot of small decisions that are not the work itself: is this
command safe to run, which model should take this turn, would memory help here,
has this turn stopped making progress. Until recently every one of those was a
hand-written rule — a list of dangerous command names, a count of capital
letters, a static model chain — or a question put to the same expensive model
that was already busy and already stuck.

Rules are free and blind. Asking the big model is slow, and it is at its worst
when asked to grade its own progress. The decision tier is the rung in between:
a fast, typed answer with a probability attached.

**It is off by default, and off means off.** The default provider answers every
question with the rule your agent already computed, calls nothing, and produces
exactly the behaviour you had before the tier existed.

---

## What it decides

| Decision | What it asks | When |
|---|---|---|
| **Shell risk** | *Is this command too risky, or not authorized by what the user asked for?* | Only for commands the lexical rules **allowed** |
| **Route** | *Which of these models is the least costly one that can do this?* | Only when a request says `auto` |
| **Recall** | *Would previously captured memory about this project help answer this?* | Only when no memory cue matched |
| **Turn progress** | *How much progress did this window of tool calls make?* | At each tool-budget checkpoint |

Each one sits **above a floor of rules that still runs first**. A command the
rules refuse is still refused, before the tier is consulted at all. The tier
only ever reaches the band the rules left undecided.

### What those bands actually are

**Shell.** The classifier is good at **destruction** — `rm -rf`, `curl | sh`,
`find . -delete`, `aws s3 rm --recursive` are all on its list. It has no entry
for the other kind of irreversible: **publication**. These are all classified
safe today, because nobody wrote them down:

```
npm publish
terraform apply -auto-approve
gh release create v1.0.0 --generate-notes
```

…and so is the next deploy verb nobody writes down. That is the band.

**Route.** `auto` resolves to a static ordered chain — your configured provider
order, optionally sorted free-first. It is a good fallback order and a poor
first guess, because it never reads the request. Every question gets the same
head: the small local model that cannot hold the file you pasted, or the
frontier model you are paying for to reformat some JSON. The tier picks where
to *start*; the rest of the chain keeps its order behind it, and an explicit
model request never reaches the tier at all.

## Turning it on

```jsonc
// ~/.config/brainrouter/config.json
{
  "cli": {
    "decisions": {
      "provider": "rules",        // "rules" (default) | "local"
      "timeoutMs": 2000,          // after this, the rule floor answers
      "maxStateChars": 8000,      // hard cap on what any one question sends
      "local":  { "model": "" },  // required for "local" — a small, fast model
      "shell":  { "low": 0.3, "high": 0.8 },
      "recall": { "threshold": 0.6 },
      "route":  { "maxCandidates": 12 }
    }
  }
}
```

**`provider`** is the switch that matters.

- **`rules`** (default) answers every question with the rule your agent already
  computed. Nothing is called, nothing is spent, nothing changes.
- **`local`** asks a small model you already have. Set
  `decisions.local.model` to a route request — `groq/llama-3.1-8b`,
  `lmstudio/qwen3-8b`, or any bare model name your router knows.

The classifier is **ours**, and it runs on **your** model. There is no decision
vendor, no second API key, and no new destination for a command line or a
prompt. If the model you name is itself hosted, the usual redaction and size
bounds still apply to everything the question carries.

A misconfiguration never silently does nothing. Each way it can fail says which
fix it needs:

```
no decision model is set — set cli.decisions.local.model to a small, fast model
cli.decisions.local.model "gpt-9" is not a model this workspace can route to
this workspace has no model configured, so there is nothing to ask
```

In every case the rule floor answers and the reason lands in
`recent-decisions.json`. You get your existing behaviour plus a line telling you
what to fix.

**`shell.low` / `shell.high`** are the bands. Below `low` the command runs; at
or above `high` it is refused; in between you are asked, through the same
confirmation the destructive-command guard uses. If you set `low` above `high`,
that is a typo and the documented defaults are used — a band that cannot be
read does not become the strictest possible policy.

**`recall.threshold`** is where a turn no cue matched still earns a briefing.

**`route.maxCandidates`** bounds how many of the chain's routes are described to
the classifier. The chain still falls back through all of them.

### Why a small model is enough

Because the question carries its own answer set. The classifier is handed one
tool it must call, whose parameters are exactly the question:

| primitive | what the model is allowed to return |
|---|---|
| `noul` | a number between 0 and 1 |
| `choice` | one of the option keys, and nothing else |
| `score` | one of the ordered levels, and nothing else |

It is not asked to be disciplined; it is handed a shape with no alternative.
Anything that gets through anyway is checked again on the way back, and an
invalid answer becomes the rule floor with the reason recorded — never a new
outcome.

## Reading what it decided

```bash
/recent-decisions        # the last 20
/recent-decisions 50
```

Each line carries the consumer, the question, the probability, what the gate did
with it, which band it fell in, who answered, and how long it took. On the
default provider every line reads `rules · 0ms` at probability 0 — which is
itself useful, because it shows the gate ran and chose not to intervene:

```
shell/risky: 0.000 → allow (< low 0.3) rules · 0ms
```

With `local` configured, the four consumers look like this:

```
shell/risky: 0.870 → deny (>= high 0.8) local · 180ms
route/start: groq/llama-3.1-8b → started on groq/llama-3.1-8b local · 140ms
recall/helpful: 0.910 → fire (>= 0.6) local · 160ms
checkpoint/progress: none → none (after 22 calls) local · 210ms
```

It is written to `recent-decisions.json` in the session directory, beside
`recent-denials.json`, so it survives a restart and can be read from a session
you are no longer in. A wrong decision should be diagnosable without anyone
having to paste a transcript.

The gateway is the exception: it serves `auto` requests but has no session, so
its route choices go to the server log instead — and stay silent on `rules`,
because then the chain head is the answer by definition.

## Is it any good? Ask it

A probability you cannot check is decoration. `0.9 risk` has to mean the thing
was risky about nine times in ten, or the bands above are arbitrary numbers.

```bash
/decision-calibration
```

```
Decision calibration — local
  local is NOT calibrated over 44 decisions (ECE 0.31, Brier 0.29) —
  most overconfident around 0.88, where it was right 41% of 22. Its answers are
  advisory: recorded and shown, with the rules deciding.

  stated → observed, by bucket
    ✓ 0.0–0.2  said 0.08, was right 11%  (9)
    ~ 0.6–0.8  said 0.71, was right 58%  (13)
    ✗ 0.8–1.0  said 0.88, was right 41%  (22)
```

Two readings, because one is not enough. **ECE** compares what the classifier
said to what happened, bucket by bucket. **Brier** scores the probability
itself, which catches what ECE alone misses: a classifier that answers 0.5 to
everything is perfectly calibrated and perfectly useless.

A provider that fails either is demoted to **advisory**. It keeps being asked
and its answer keeps being recorded — shown as `advised 0.97 (not used)` — but
the rules decide. It is not switched off, because a classifier that went silent
could never earn its way back.

**Most decisions will never be graded, and that is correct.** Only a gate that
actually finds out may label one, and today that means the shell prompt: if you
approve a command the tier flagged, the tier was wrong; if you refuse it, the
tier was right. An auto-deny learns nothing. A silent session learns nothing.
Unlabelled decisions are excluded from the grade rather than counted as wins, so
expect to read this for a long time:

```
  8 of 30 decisions needed to judge local; 210 more are recorded but nothing
  has said yet whether they were right
```

That is the honest state. Never having been measured is not the same as having
been measured and failed, so an unmeasured provider is trusted, not demoted.

## What it will never do

- **Generate text.** A `choice` returns one of the keys it was handed, a `score`
  one of the levels you defined, a `noul` a number between 0 and 1. A provider
  that answers with anything else is rejected and the rule stands.
- **Block work because it is broken.** If the provider throws, times out, or
  skips a question, the answer is the rule your agent already computed. A
  decision tier that is down must not start refusing commands.
- **Escalate to a bigger model.** The decision model is resolved with no
  fallback chain behind it: it goes to the model you named or nowhere. A System
  One question must never cost a System Two call, and must never quietly bill
  one.
- **Override a rule that fired.** The recall tier can *add* a briefing the cues
  missed; it can never remove one they asked for. The shell floor's refusals are
  final. The route tier re-heads the chain but never drops a fallback.
- **Send secrets.** Commands and prompts pass through the same redaction a
  transcript gets, and every payload is size-bounded before it is built.

---

Design and rationale:
[ADR-061 — A System One tier for the loop](../decisions/ADR-061-a-system-one-tier-for-the-loop.md).
