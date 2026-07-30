---
name: background-work-skill
description: Build or change queues, jobs, workers, schedulers, retries, leases, and distributed workflows with bounded concurrency and idempotent recovery.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, lsp, run_command, artifact_write]
---

# Reliable background work

## Overview

Assume background work can be duplicated, delayed, interrupted, reordered, or
run concurrently. Make ownership, durable state, retry ceilings, cancellation,
and recovery visible rather than relying on one healthy process.

## When to Use

Use for queues, scheduled jobs, workers, webhooks, event consumers, leases,
distributed workflows, retries, polling, fan-out, and long-running operations.

## Workflow

1. Define the durable unit of work, ownership key, state machine, completion
   evidence, and what makes processing safe to repeat.
2. Separate enqueue acceptance from execution. Persist enough state to resume,
   reconcile, cancel, and explain the job after a process restart.
3. Bound concurrency, attempts, execution time, backoff, payload size, and
   result size. Add jitter and a terminal failure path where repeated retries
   would amplify load.
4. Make side effects idempotent through stable keys, compare-and-set state,
   uniqueness, or downstream idempotency support. Treat at-least-once delivery
   as the default unless stronger guarantees are proven.
5. Handle lease expiry, stale workers, partial progress, shutdown, cancellation,
   and poison input without losing or silently completing work.
6. Test duplicate delivery, concurrent claims, restart, timeout, cancellation,
   exhausted retries, and dependency recovery.

## Verification

- [ ] Work state and completion evidence survive process restart.
- [ ] Concurrency, attempts, time, payload, and output are bounded.
- [ ] Duplicate delivery and stale ownership cannot duplicate side effects.
- [ ] Cancellation and terminal failure are explicit and observable.
- [ ] Recovery tests cover interruption and dependency failure.

## Red Flags

- Fire-and-forget work with no durable status or reconciliation.
- Infinite retry, fixed tight retry loops, or unbounded fan-out.
- A lease with no expiry or a worker heartbeat with no stale-owner recovery.
- “Exactly once” claims based only on queue configuration.
