---
name: backend-testing-skill
description: Verify backend changes at contract and integration boundaries with deterministic success, denial, concurrency, retry, migration, and dependency-failure evidence.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, lsp, run_command, artifact_write]
---

# Backend verification

## Overview

Test the smallest boundary that proves the changed behavior, then add real
integration coverage where process, database, queue, network, or deployment
semantics matter. A green happy path is not evidence for failure behavior.

## When to Use

Use after backend API, authorization, persistence, migration, background-work,
configuration, performance, or reliability changes.

## Workflow

1. State the contract and risk introduced by the change. Map each material risk
   to one deterministic check before choosing test layers.
2. Use pure unit tests for domain rules and parsers; boundary tests for
   validation, authorization, and error mapping; real integration tests for
   persistence, transactions, migrations, queues, and lifecycle behavior.
3. Cover success plus malformed input, denial, missing resources, duplicates,
   concurrency, timeout, cancellation, partial failure, retry exhaustion, and
   dependency recovery as relevant.
4. Keep fixtures minimal and isolated. Use production schemas and adapters when
   the behavior depends on them; do not replace the property under test with a
   permissive mock.
5. Assert observable contracts and durable state, not private call order.
   Prove tenant isolation and secret redaction at the boundary.
6. Run the narrow affected set locally, record exact evidence, and leave broad
   workspace verification to the established merge gate unless risk requires it.

## Verification

- [ ] Every material changed contract has a deterministic check.
- [ ] Authorization denial and tenant isolation are covered.
- [ ] Data, queue, and lifecycle semantics use real integration boundaries.
- [ ] Concurrency, retries, cancellation, and dependency failure are tested where relevant.
- [ ] Assertions target behavior and durable state rather than implementation detail.

## Red Flags

- Mocking the database or queue when their semantics are the feature.
- Tests that pass only because they share mutable global state or execution order.
- Snapshotting large responses without asserting security or contract meaning.
- Running the full repository suite as a substitute for a focused regression.
