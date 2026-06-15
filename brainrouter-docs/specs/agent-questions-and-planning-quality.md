# Better Questions & Planning — decode + match

**Status:** IMPLEMENTED (Phase 1 + Phase 2), pending review of the live behavior
**Owner:** anhdang
**Goal:** Make BrainRouter's clarifying questions, planning, and delegation prompts match the quality of the reference agent (Claude Code) the user is comparing against.

## Implementation log (PARITY-Q)
- **P1 — systemPrompt.ts**: vague-exploration STOP now carves out consequential user-owned forks; option-quality bar (consequence-laden descriptions, recommend-first + `(Recommended)`, hedge option); plan-quality stance (≥3 steps, verifiable outcome, `acceptance` cue); 5-part delegation contract. A duplicate `update_plan` line was removed; the base-prompt token budget was raised 4,500→4,900 with justification (`prompt.test.ts`).
- **P1 — specs.ts**: `ask_user_choice` description gained the option-quality bar; `update_plan` description rewritten to carry the planning bar inline; `acceptance` property added to plan items.
- **P2 — multi-question `ask_user_choice`**: schema accepts a `questions[]` batched form OR the single form; handler asks each in turn and returns aggregated `{answers}` (test: `interaction-port.test.ts`).
- **P2 — `acceptance` field**: flows model → `update_plan` → `taskStore` (`formatPlan`/`/plan`) → `plan-update` protocol event → desktop `PlanPanel` (renders under each step).
- **P2 — delegation nudge**: terse, cue-less child prompts get one role-appropriate return-format line appended (read roles → "report findings only"; write roles → "what you changed + how verified").
- **Verified**: CLI 1,390/1,390 tests, desktop host 14/14, both typecheck clean; acceptance criteria render live in the desktop Plan panel; nothing committed pending review.

---

## 0. Framing (read this first)

There is **no secret system prompt** that produces good questions. The reference agent is a strong model steered by ~6 transferable rules. A verbatim prompt dump would not transfer (different tools, different harness) and isn't the asset — the **rules** are. This doc extracts those rules, measures BrainRouter against them (with `file:line` evidence), and proposes surgical edits.

BrainRouter is closer than it feels. It already has:
- `ask_user_choice` with the right shape — `specs.ts:262`
- `update_plan` — `specs.ts:298`
- a clarify overlay — `systemPrompt.ts:171`
- strong delegation guidance ("never delegate understanding") — `systemPrompt.ts:309`
- a `planning-skill` that already prescribes **acceptance criteria per task** and **stop-for-approval** — `skills/agent/planning-skill/SKILL.md`

The gap is that the **quality bar lives in skills/docs, not in the always-on runtime prompt**, and three specific principles are under-specified. Fixing it is mostly prompt/tool-description work, not new systems.

---

## 1. What "good" looks like (decoded from the two reference screenshots)

### 1a. The good QUESTION ("Runner target")

> *"Which serving path should we target for diffusion-gemma? This decides where all Phase 1+ code lands."* → 3 options, each with a description like *"MLX … Apple Silicon only; matches the reporter; fully under our control. Serves an MLX-converted build (convert from safetensors; google repo is gated, may need an ungated mirror), not the literal GGUF."*

Why it's good — 5 properties:
1. **It's asked at all.** This is a consequential, hard-to-reverse, user-owned fork (where *all* future code lands). The agent did *not* guess. ← this is the property BrainRouter most often gets wrong (it's biased to never ask).
2. **The question states the stakes** — "This decides where all Phase 1+ code lands." The user understands *why* it matters.
3. **Options are mutually exclusive and named by the decision**, not by implementation detail.
4. **Each description carries the real tradeoff AND the risk** — "Apple Silicon only", "google repo is gated, may need an ungated mirror", "tracks an unmerged DRAFT … most brittle". The user can decide **without external knowledge**.
5. **There's an explicit hedge option** ("MLX now, llama.cpp later") — a sequencing escape hatch, not just A-vs-B.

### 1b. The good DELEGATION prompt ("Extract reference denoising algorithm")

A sub-agent prompt that is ~40 lines: exact `gh` commands to fetch sources, 6 numbered requirements, named constants to find (`N_SC_TOPK`, `entropy_bound`, …), and an **exact return contract**: *"Return: (a) clean numbered pseudocode, (b) a table of every constant/default with value and source line, (c) any ambiguities … quote key lines with file:line. Do NOT modify files."*

Why it's good — 5 properties (the **delegation contract**):
1. **Context + why** — what's being built and why this extraction matters.
2. **Exact inputs** — the precise commands/files, not "find the relevant files".
3. **The specific task** — numbered, concrete sub-questions, no synthesis pushed onto the child.
4. **An exact RETURN format** — (a)/(b)/(c) with shape. The parent knows exactly what comes back.
5. **Hard constraints** — "quote file:line", "Do NOT modify files". Boundaries are explicit.

These ten properties are the whole target.

---

## 2. Clarifying questions

### Principles (the rules behind 1a)
- **Ask only when the answer changes what you do next AND the choice is genuinely the user's** — architecture, scope, irreversible/destructive, external-facing, or "where does everything live". Everything else: pick the sensible default, state it, move on.
- **Never ask what you can verify** from the code, the request, or a convention.
- **Each option's description = the consequence/tradeoff/risk**, written so the user needs no outside knowledge. Not a restatement of the label.
- **Recommend.** Put the recommended option first and mark it `(Recommended)`. A question with no steer is lazy.
- **Batch** related questions (up to ~4) in one ask; don't drip them one per turn.
- **State the stakes** in the question when the decision is consequential.

### BrainRouter today
- Strong **anti-clarify** bias: *"If you find yourself about to write a clarifying question, STOP … pick the most plausible interpretation"* — `systemPrompt.ts:166`. Correct for exploration ("analyze X"), but it has **no carve-out for consequential user-owned forks**, so the model under-asks exactly where asking is right (the "Runner target" case).
- The good clarify rules only fire in **`grill-me` skill mode** — `systemPrompt.ts:171-172`. Outside that skill they're absent.
- `ask_user_choice` description is good but **doesn't say**: describe *consequences* not labels; recommend-first; `(Recommended)`; state the stakes — `specs.ts:262-296`.
- One question per call — **no batching** of related questions.

### Proposed edits (Phase 1, prompt-only)
1. **`systemPrompt.ts` — add a small always-on "When to ask" block** (not gated on a skill). Distill: *don't clarify exploration; DO clarify a consequential, user-owned, hard-to-reverse fork (architecture / scope / where code lands / data-loss / external-facing). When you ask, state the stakes in one clause.*
2. **`specs.ts` `ask_user_choice` description — append the option-quality bar:** *"Each description states the CONSEQUENCE and RISK of that choice (so the user needs no outside knowledge), not a restatement of the label. Put the option you'd pick FIRST and mark its label `(Recommended)`. Include a sequencing/hedge option when 'do A now, B later' is viable."*
3. **Soften the absolute STOP at `systemPrompt.ts:166`** to "STOP *for vague exploration*; for a consequential fork you can't derive, ask one well-formed `ask_user_choice`."

### Proposed edit (Phase 2, structural)
4. **Multi-question batching.** Today `ask_user_choice` is single-question. Add an optional `questions: [...]` array form (mirrors the reference's up-to-4 batched questions) so the agent can disambiguate scope + format + target in one pause instead of three turns. Renderer/CLI picker already handles one; extend to N.

---

## 3. Planning

### Principles
- **Plan only for ≥3 non-trivial steps.** A 1–2 step task gets done, not planned.
- **Each item = ONE verifiable outcome**, imperative ("Add X", "Migrate Y"), with an implicit acceptance check.
- **Exactly one `in_progress`; mark `completed` the moment it's done**, never in batches.
- **The plan is living** — rewrite it as you learn; a stale plan is worse than none.
- **Size down** — never start an L/XL item; decompose first.

### BrainRouter today
- `update_plan` runtime description is **one thin line** — `specs.ts:298-299` — no quality bar (verifiable outcome, sizing, when-to-plan). The model gets the *mechanism* but not the *standard*.
- The standard **does** exist in `planning-skill` (acceptance criteria per task, XS/S/M sizing, stop-for-approval) — but **only when that skill is loaded**. Most turns don't load it.
- `update_plan` items are `{step, status}` — no acceptance/verification field.

### Proposed edits (Phase 1, prompt-only)
1. **Rewrite the `update_plan` description** to carry the planning-skill's bar inline: *when to plan (≥3 non-trivial steps), each item is one verifiable outcome in imperative voice, one `in_progress`, mark done immediately, rewrite as you learn.*
2. **Add a 3-line planning stance to the always-on prompt** (it's currently only at `systemPrompt.ts:296,346` as terse mechanics) distilled from the skill.

### Proposed edit (Phase 2, structural)
3. **Optional `acceptance` string per plan item** (`{step, status, acceptance?}`) so each step names how it'll be verified — surfaces in `/plan` and the desktop Plan panel. This is the single biggest planning-quality lever and it's already the skill's rule.

---

## 4. Delegation prompts (the biggest, easiest win)

### Principles — the 5-part contract (from 1b)
Every child prompt must carry: **(1) context + why · (2) exact inputs (files/commands/line refs) · (3) the specific task · (4) the EXACT return format · (5) hard constraints/boundaries.**

### BrainRouter today
- Guidance is genuinely good — "never delegate understanding", "brief like a smart colleague", "include file paths, line numbers" — `systemPrompt.ts:308-309`. This covers (1)(2)(3).
- **Missing the explicit (4) return contract and (5) constraints structure** — the exact thing that makes the gold-standard prompt great. The guidance says "brief well" but doesn't prescribe "specify what comes back and what's off-limits".
- The only runtime check is non-empty prompt — `tools.ts:638`. No nudge toward the contract.

### Proposed edits
1. **(Phase 1)** Add to the orchestration section a one-line **delegation contract**: *"Every child prompt states (a) what you're building and why, (b) the exact files/commands/line refs to use, (c) the specific task, (d) the EXACT return format you want back, (e) constraints (e.g. 'quote file:line', 'do NOT modify files'). Terse prompts get shallow work."*
2. **(Phase 2, optional)** A soft lint in `spawn_agent`/`task_agent`: if a child prompt is < ~200 chars or has no return-format cue, append a one-line system nudge to the child ("state your answer as: …") rather than failing. Low-risk, improves the long tail.

---

## 5. The harness layer (beyond prompts — how the reference agent actually operates)

Prompts set intent; the **loop** sets quality. The reference agent's habits, and where BrainRouter stands:

| Habit | What it means | BrainRouter status |
|---|---|---|
| **Verify before claiming** | run it / read the output before saying "done" | ✅ has `verificationGate.ts`, `deliverableCheck.ts` |
| **Plan as you learn** | rewrite the plan mid-task | ⚠️ `update_plan` exists; weakly prompted (§3) |
| **Adversarial verify** | a second pass tries to *refute* a finding | ⚠️ `/review` does multi-agent; not a default habit |
| **Context discipline** | offload big payloads, keep the window lean | ✅ strong — `memory_working_offload`, auto-compact |
| **Batch parallel reads** | fan out independent tool calls in one message | ✅ explicitly prompted — `systemPrompt.ts:298` |
| **Self-contained delegation** | children get the full contract | ⚠️ §4 — the one real gap |
| **Recommend, don't survey** | give a steer, not an options dump | ⚠️ §2 — add recommend-first |

Read: BrainRouter's **harness is strong**; the deltas are concentrated in **questions (recommend + when-to-ask)**, **planning (carry the bar into the prompt)**, and **delegation (the return contract)** — all promptable.

---

## 6. Proposed rollout

**Phase 1 — prompt & tool-description edits (no code risk, reversible):**
- `systemPrompt.ts`: when-to-ask block; recommend-first; planning stance; delegation contract; soften line 166.
- `specs.ts`: `ask_user_choice` option-quality bar; rewrite `update_plan` description.
- Touches 2 files, ~30 lines of prompt text. Shippable behind a quick eval.

**Phase 2 — structural (each independently optional):**
- Multi-question `ask_user_choice`.
- `acceptance` field on plan items (+ surface in `/plan` and desktop Plan panel).
- Soft delegation-prompt nudge.

**Phase 3 — evaluate:**
- A/B with `skill-creator`'s eval harness (or a hand set): ~6 ambiguous prompts (does it ask the right one, recommend, describe consequences?) and ~6 multi-step tasks (is the plan verifiable, living, right-sized?). Compare pre/post on the 10 properties in §1.

---

## 7. The one-paragraph version

BrainRouter already has the machinery and even the written standards (in `planning-skill`). It under-performs because (1) it's biased to *never* ask, with no carve-out for consequential user-owned forks; (2) its `ask_user_choice` options restate labels instead of stating consequences, and never recommend; (3) the planning quality bar lives in a skill that's usually not loaded, while the runtime `update_plan` description is one line; and (4) delegation prompts omit the explicit return-contract + constraints that make a child's output sharp. All four are fixable with ~30 lines of prompt/tool-description edits (Phase 1), with three optional structural upgrades behind them (Phase 2).
