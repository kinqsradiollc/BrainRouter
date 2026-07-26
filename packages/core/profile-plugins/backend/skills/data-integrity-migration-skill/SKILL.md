---
name: data-integrity-migration-skill
description: Change backend domain models, persistence, schemas, and migrations while preserving invariants, tenant scope, rollback safety, and operational compatibility.
allowed-tools: [read_file, list_dir, grep_search, glob_files, edit_file, apply_patch, run_command]
---

# Data integrity and migrations

## Overview

Treat persisted data as a long-lived contract. Put invariants at the strongest
reliable layer, scope every operation correctly, and design migrations for the
mixed-version and partially completed states that exist during rollout.

## When to Use

Use for domain models, repositories, SQL, ORM changes, indexes, constraints,
transactions, data backfills, schema migrations, retention, and tenant-scoped
queries.

## Workflow

1. Identify the data owner, invariants, tenant or organization key, lifecycle,
   volume, access patterns, and every reader and writer affected by the change.
2. Choose the strongest enforcement layer: database constraint for stored
   invariants, transaction for atomic state changes, and application validation
   for user-facing errors. Do not rely on one layer to replace the others.
3. Design expand-migrate-contract rollout when old and new code may overlap.
   Make backfills bounded, resumable, idempotent, observable, and safe to retry.
4. Preserve scope in every read, write, join, cache key, and uniqueness rule.
   Add indexes from measured query shapes, not table size guesses alone.
5. Define rollback or forward-recovery before applying destructive changes.
   Separate irreversible cleanup from the compatibility migration.
6. Test constraints, transaction rollback, duplicates, concurrent updates,
   partial backfills, empty and large datasets, and cross-scope denial.

## Verification

- [ ] Domain and persistence invariants are explicit and enforced.
- [ ] Tenant or organization scope is present in every relevant path.
- [ ] Migration ordering works with mixed application versions.
- [ ] Backfills are bounded, resumable, idempotent, and observable.
- [ ] Rollback or forward-recovery is documented and tested where material.

## Red Flags

- Destructive schema changes in the same step that deploys new readers.
- A backfill that must finish in one process or one transaction.
- Application-only uniqueness or referential-integrity assumptions.
- Adding an index without checking its write cost and actual query shape.
