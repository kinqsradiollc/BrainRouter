---
name: verify-loop
description: Gate agent output behind an automated green check that re-runs the worker on failure, so nothing ships unverified. Use when an agent writes code and claims done without proof, when a background/unattended run must self-validate before opening a PR, or when a weak model needs an objective pass/fail signal. Use to wrap a worker in a bounded write → verify → re-spawn-on-fail loop. References debugging-and-error-recovery and shipping-skill.
hints: |
  - Define ONE `verify` command (typecheck + lint + test) that is the single source of truth for "green".
  - The worker's "done" means nothing — only a passing verify does. Never gate on the model's self-assessment.
  - On failure, re-spawn the worker WITH the failure output, bounded by a retry cap; don't loop forever.
  - A red verify must block the PR/merge; green-or-nothing, with the failure surfaced.
  - Keep verify fast (incremental/affected-only) so the loop is tight enough to actually use per task.
---

# Verify Loop (green-gate before ship)

## Overview

Agents — especially weak or unattended ones — claim "done" without evidence. A verify loop replaces self-assessment with an **objective green check**: the worker produces a change, an automated `verify` runs, and on failure the worker is **re-spawned with the failure output**, bounded by a retry cap. Only a passing verify lets the result ship (open a PR / merge). This is the gate that makes background and fleet automation trustworthy.

## When to Use

- An agent writes code and reports success without running anything
- A background/unattended run must self-validate before producing a PR
- A weak/local model needs an objective PASS/FAIL signal to iterate against
- You're composing a `bounded-agent-harness` or `fleet-migration` and need the green gate

**When NOT to use:** exploratory/throwaway work with no shippable artifact; or a change with no meaningful automated check (then add the check first, or gate on a human).

## Workflow

1. **Define the single `verify` command** = typecheck + lint + test for the affected scope. This is the only definition of "green" the loop trusts.
2. **Run the worker** to produce the change (in an isolated worktree for unattended runs).
3. **Run `verify`.** On green → proceed to the gate. On red → capture the failure output.
4. **Re-spawn the worker with the failure context** (the exact errors), bounded by a retry cap (e.g. 2–3). Each retry must change something; identical retries are wasted.
5. **Gate on green.** Only a passing verify opens the PR / merges. On exhausted retries, stop and surface the last failure — never ship red, never silently swallow it.

## Patterns

- **One verify command:** agents and CI call the same `verify`; no divergence between "passed locally" and "passed in CI".
- **Failure-fed retry:** feed the verifier's output back into the re-spawn so the worker fixes the actual error, not a guess.
- **Bounded, not infinite:** a retry cap prevents a stuck worker from looping forever; exhaustion is a reported outcome.
- **Worker/verifier split:** the thing that writes is not the thing that judges — an independent verify call removes the self-grading bias.
- **Fast feedback:** incremental/affected-only verify keeps the loop short enough to run per task.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "The agent said it tested it." | Self-report is not verification. Run the check. |
| "Verify is slow, skip it for small changes." | Unverified small changes are how green CI rots. Make verify fast, don't skip it. |
| "Loop until it passes." | Unbounded loops burn tokens on a stuck task. Cap retries; surface exhaustion. |
| "Just retry the same way." | An identical retry repeats the failure. Feed the error back so the next attempt differs. |

## Red Flags

- The PR/merge gate trusts the model's "done" instead of a passing check.
- `verify` differs between local and CI (two sources of truth).
- The loop has no retry cap, or retries don't include the failure context.
- A red verify was swallowed and the artifact shipped anyway.

## Verification

- A change that breaks a test never reaches the PR/merge gate (the loop catches it).
- On failure, the re-spawned worker receives the actual error text and the next attempt addresses it.
- The loop stops at the retry cap and reports the last failure (no infinite loop, no silent pass).
- The same `verify` command is what CI runs (green here ⇒ green there).
