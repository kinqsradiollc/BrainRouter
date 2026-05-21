---
name: performance-skill
description: Redis caching, Postgres replication, query indexing, and connection management rules for performance and scalability. Use when writing database queries, configuring caching layers, or auditing backend load speeds.
hints: |
  - Use Cache-Aside pattern for read-heavy, slowly changing data models.
  - Actively invalidate cache keys upon data modifications (POST, PATCH, DELETE).
  - Explicitly route read-only operations to database replicas and mutations to the primary host.
  - Run EXPLAIN ANALYZE on complex database queries to ensure active index coverage.
  - Avoid executing heavy calculations or string manipulations inside SQL queries.
---

# Performance & Scalability Skill

## Overview

This skill ensures backend API structures remain fast, responsive, and resource-efficient as user traffic and data volume grow. Enforcing strict caching architectures, database replication rules, indexing profiles, and application-layer calculations prevents latency spikes and keeps resource usage optimized.

## Workflow

- **[PERF-001] Cache-Aside Pattern**
  - Use the "Cache-Aside" strategy for frequently read, slowly changing data structures.
  - Workflow: Check Cache (Redis) -> If hit, return -> If miss, query Database -> Set Cache (Redis) with TTL -> Return.
  - Set reasonable TTLs (e.g., 5-10 minutes) based on data volatility.

- **[PERF-002] Proactive Cache Invalidation**
  - When data is modified (POST, PATCH, DELETE), proactively invalidate the associated cache keys using `cache.del(key)`.
  - Use namespace-based key patterns (e.g., `spots:detail:*`) to invalidate multiple related caches simultaneously.

- **[PERF-003] Read/Write Replication**
  - Route all read operations (`SELECT`) to database replicas to distribute read load.
  - Route all mutations (`INSERT`, `UPDATE`, `DELETE`) to the primary database.
  - Exception: Use the primary database for "Read-after-Write" scenarios where replication lag would cause visual inconsistency for the active user.

- **[PERF-004] Index-First Design**
  - Every column used in a `WHERE`, `JOIN`, or `ORDER BY` clause must have a corresponding database index.
  - Use database performance profiling tools (e.g., `EXPLAIN ANALYZE`) to verify query plans before merging database alterations.

- **[PERF-005] No Heavy Computations in SQL**
  - Avoid executing complex arithmetic, string formatters, or business logic inside SQL queries. Keep the database focused on fast indexing and retrieval; run formatting and calculations in the application layer.

## Implementation Pattern

```typescript
import { cache } from '../../utils/redis';
import { readQuery } from '../../database/replication';

export const getVibes = async (req: Request, res: Response) => {
  const CACHE_KEY = 'vibes:list:v1';
  
  // 1. Check Cache [PERF-001]
  const cached = await cache.get(CACHE_KEY);
  if (cached) return sendSuccess(res, { vibes: cached });

  // 2. Hit Read-Replica [PERF-003]
  const result = await readQuery('SELECT id, name FROM categories ORDER BY name ASC');
  const vibes = result.rows;

  // 3. Set Cache [PERF-001]
  await cache.set(CACHE_KEY, vibes, 600); // 10 min TTL

  return sendSuccess(res, { vibes });
};
```

---

## When to Use

- Writing new database queries (SQL, Prisma models, ORMs) or API response endpoints.
- Setting up or tuning Redis caching layers for frequently accessed data structures.
- Auditing database query plans, slow query logs, or indexing schemas.
- Configuring database replication routing (primary vs. read-replicas).

**When NOT to use:**
- Local static CLI tools or developer setups where data fits entirely in memory and has no persistent database.
- Trivial, low-frequency administration actions that run off-peak and do not impact core application user latency.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The database is fast enough; we don't need caching yet." | Caching reduces origin server load and eliminates roundtrips. Waiting for database saturation to implement caching causes high-severity production outages. |
| "I'll let the cache expire on its own via TTL." | Relying solely on TTL means users will see stale data for long periods. Proactive invalidation on update guarantees visual consistency and real-time freshness. |
| "Adding indexes on every column is always safe." | Too many indexes degrade write and update speeds because the database must update the indexes for every write. Focus indexing on columns actually used in filter/sort criteria. |

## Red Flags

- Fetching full database rows (`SELECT *` or unrestricted ORM relations) when only a subset of fields is used.
- Heavy reads targeting the primary database instance when read-replicas are available.
- Heavy aggregate calculations, string operations, or custom formatting executed inside SQL database statements.
- Implementing caching without a clear, proactive invalidation mechanism (`cache.del(key)` or pattern-based invalidations) on state changes.

## Verification

After completing the performance implementation, verify:
- [ ] Redis caching hit rate is confirmed (cached reads bypass database entirely).
- [ ] Associated cache keys are successfully removed or updated upon resource mutations.
- [ ] Database query profiles (`EXPLAIN ANALYZE` or ORM profiling) show active index scans rather than sequential table scans.
- [ ] Core mutations write to the primary database, while read-only routes hit replica pools.
- [ ] Clean performance data is gathered and validated against latency targets (e.g. sub-100ms API response).
