---
name: bounded-agent-harness
description: Get reliable output from weak or local models by tightening the harness instead of the prompt. Use when running a small/quantized/local model, when an agent loops, drifts, stalls before acting, or emits malformed tool calls, or when designing a background executor that must finish unattended. Use to pick a bounded profile — tool allowlist, turn/retry caps, forced structured output, verify loop, micro-task decomposition.
hints: |
  - A tight bounded harness beats a clever prompt — spend the effort on caps + allowlist + forced output, not more instructions.
  - Pin a hard tool allowlist (read/glob/grep/list/edit/run + wait/finish/discovery); hide the long tail entirely.
  - Force structured output (tool_choice) for the final answer / routing decision, with a drop-and-retry fallback for endpoints lacking tool support.
  - Gate every cap by model family — caps too low abort legitimate long work on strong models.
  - Decompose into single bounded tasks; pair each spawned child with an explicit output contract so its return parses.
---

# Bounded Agent Harness (local / weak models)

## Overview

The lesson from large-scale background-agent systems: **reliability comes from the harness, not the prompt.** A weak or local model drifts (stalls before acting, promises-then-asks, fans-out-without-spawning), loops, or emits malformed tool calls. Repeating instructions doesn't fix it; **bounding** it does — a small tool allowlist, hard turn/retry caps, forced structured output, a verify loop, and micro-task decomposition. This skill defines that profile and when to apply it.

## When to Use

- Driving a small/quantized/local model, or any model that drifts/loops
- The agent stalls before acting, promises work then asks, or skips verification
- Tool calls come back malformed (truncated args, dropped nested args, call storms)
- Designing a **background executor** that must complete unattended and produce a clean result

**When NOT to use:** a strong frontier model on an interactive task where tight caps would cut off legitimate long work — keep the harness loose and let it run.

## Workflow

1. **Detect the failure mode.** Looping (same tool sequence), stalling (preamble, no action), malformed calls, deferral (promises, never delivers), verify-skipped. Each has a different lever.
2. **Select a model-family profile**, not a global cap. Strong → loose. Weak/local → bounded: lower max-tool-loops, lower repeat-sequence limit, lower storm threshold, smaller tool budget, tighter spawn depth.
3. **Pin a hard tool allowlist** — not a soft relevance budget. Expose only `{read, glob, grep, list, edit/apply_patch, run_command}` plus the orchestration `wait`/`finish`/discovery tools. Hide everything else so the model can't wander.
4. **Force structured output** on terminal/decision steps via `tool_choice` (e.g. a `submit_answer`/`route` function), and **replicate the drop-and-retry fallback** so endpoints without tool support degrade instead of 400-ing.
5. **Compose a verify loop** (see `verify-loop`): worker writes → verifier returns PASS/FAIL → on FAIL re-spawn the worker with the failure context, bounded by a retry cap.
6. **Decompose into single bounded tasks.** Steer the model to direct-tool / spawn-inline tiers, away from broad fan-out; give each child an explicit output contract; offload large tool output by reference for small context windows.

## Patterns

- **Caps over coaching:** when a model drifts, lower a cap or shrink the allowlist before adding prompt text.
- **Allowlist > budget:** a hard, tiny tool set beats a soft relevance ranking for weak models — they can't misuse what they can't see.
- **Force the shape:** the final deliverable as a schema-shaped tool call is parseable; free text is a coin flip.
- **Repair the calls:** sanitize/flatten malformed tool calls (truncated JSON, dropped nested args, identical-call storms) rather than retrying blind.
- **Verify, don't trust:** a weak worker's "done" means nothing until a verifier confirms green.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "Just write a better system prompt." | Prompt-only autonomy is brittle on weak models. The bounded runtime guards are what hold. |
| "Give it all the tools, it'll figure it out." | A large tool surface invites wandering and hallucinated capabilities. Pin the minimal set. |
| "Lower every cap to be safe." | Global low caps abort legitimate long work on strong models. Gate by model family. |
| "tool_choice forcing will just work." | Endpoints without tool support 400 — you must port the drop-and-retry fallback. |

## Red Flags

- You're adding prompt paragraphs to fix a looping/stalling model instead of tightening caps.
- The "allowlist" is a soft relevance budget the model can retry past.
- Caps are global, not model-family-gated, and a long task aborted mid-way.
- Forced structured output was enabled without a fallback and local endpoints started erroring.

## Verification

- Run a fixed multi-step task with the profile ON vs OFF on the target local model: ON completes with valid tool calls; OFF drifts/loops/malforms.
- Confirm the hard allowlist hides the long tail (the model can't invoke a hidden tool; the "hidden by budget" path triggers, not a crash).
- Confirm forced output produces a schema-shaped final answer, and a non-tool endpoint degrades via fallback rather than 400.
- Measure with an eval harness (completion rate + tool-call validity), not a single anecdote.
