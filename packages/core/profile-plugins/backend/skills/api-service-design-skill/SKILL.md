---
name: api-service-design-skill
description: Design or change backend APIs and service boundaries with explicit contracts, validation, compatibility, idempotency, and failure semantics.
allowed-tools: [read_file, list_dir, grep_search, glob_files, edit_file, apply_patch, run_command]
---

# API and service contract design

## Overview

Treat an API as a durable boundary between independently changing systems.
Start from the caller's job and the existing contract, then make inputs,
outputs, ownership, errors, compatibility, and retry behavior explicit before
changing implementation details.

## When to Use

Use for HTTP, RPC, GraphQL, webhook, event-consumer, controller, route, service,
or public library-boundary work.

## Workflow

1. Trace the request from caller to side effects and back. Identify the owning
   layer, current consumers, trust transitions, and the source of truth.
2. Define the contract: method or operation, bounded inputs, validated types,
   success result, stable error taxonomy, authentication context, pagination,
   concurrency, and idempotency where retries are possible.
3. Preserve compatibility by preferring additive fields and explicit version
   transitions. Search all consumers before changing names, meanings, defaults,
   status codes, event shapes, or ordering.
4. Keep transport parsing at the boundary and domain decisions behind a small
   service interface. Avoid duplicating authorization, validation, or
   persistence policy across handlers.
5. Implement the smallest complete change, including cancellation, timeout, and
   partial-failure behavior relevant to the operation.
6. Verify contract examples and negative cases, then report the changed
   contract, compatibility impact, and any rollout dependency.

## Verification

- [ ] Inputs are bounded and validated before reaching domain logic.
- [ ] Success and failure shapes are deterministic and consumer-safe.
- [ ] Retries, duplicates, cancellation, and timeouts have defined behavior.
- [ ] Existing consumers and compatibility constraints were checked.
- [ ] Authorization and persistence remain owned by their proper boundaries.

## Red Flags

- A handler that mixes transport parsing, policy, domain logic, and storage.
- Returning internal exceptions or persistence records as a public contract.
- Retrying a mutating operation without an idempotency strategy.
- Calling a breaking field rename “internal” without checking consumers.
