---
name: production-readiness-skill
description: Prepare backend services for deployment with explicit configuration, health, observability, capacity, performance, shutdown, and failure-isolation behavior.
allowed-tools: [read_file, list_dir, grep_search, glob_files, edit_file, apply_patch, run_command]
---

# Backend production readiness

## Overview

Production readiness is the service's ability to start, serve, degrade, stop,
and recover predictably under real load and dependency failure. Measure the
critical path before adding complexity.

## When to Use

Use for containers, deployment manifests, runtime configuration, health checks,
logging, metrics, tracing, alerts, performance, caching, connection pools,
capacity, and incident hardening.

## Workflow

1. Identify the service boundary, dependencies, startup contract, critical user
   path, resource limits, expected load, and failure budget.
2. Separate non-secret configuration from write-only secrets. Validate required
   configuration at startup without echoing sensitive values.
3. Implement distinct liveness and readiness semantics. Readiness must reflect
   whether the instance can serve safely without turning transient dependency
   failures into restart loops.
4. Add structured, bounded observability for requests and jobs: stable operation
   names, correlation, latency, outcomes, saturation, retries, and error classes.
   Avoid sensitive or unbounded fields.
5. Measure before tuning. Address algorithm, query, payload, batching,
   connection, or cache behavior at the bottleneck and keep invalidation and
   consistency explicit.
6. Verify graceful shutdown, draining, dependency timeout, overload, degraded
   mode, rollback, and recovery using the smallest production-representative
   environment available.

## Verification

- [ ] Startup validates configuration without exposing secrets.
- [ ] Liveness, readiness, shutdown, and draining semantics are correct.
- [ ] Logs, metrics, and traces explain latency, errors, retries, and saturation.
- [ ] Performance work is based on measurement and preserves correctness.
- [ ] Dependency failure, overload, rollback, and recovery were exercised.

## Red Flags

- Health endpoints that always return success.
- Unbounded request labels, payloads, logs, queues, or in-memory caches.
- Increasing timeouts or replicas without locating the bottleneck.
- Container success treated as proof of application readiness.
