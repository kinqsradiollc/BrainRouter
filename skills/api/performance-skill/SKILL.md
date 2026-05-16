---
name: performance-skill
description: Redis caching and Postgres replication rules for performance and scalability.
---

# Performance & Scalability Skill

## Overview

This skill ensures remains fast and responsive as the user base and data volume grows.

## Workflow

- **[PERF-001] Cache-Aside Pattern**
  - Use the "Cache-Aside" strategy for frequently read, slowly changing data (e.g., Vibe lists, Spot details).
  - Workflow: Check Redis -> If miss, query DB -> Set Redis -> Return.
  - Set reasonable TTLs (e.g., 5-10 minutes).

- **[PERF-002] Proactive Cache Invalidation**
  - When data is updated (POST/PATCH/DELETE), proactively delete the associated cache keys using `cache.del(key)`.
  - Use key patterns (e.g., `spots:detail:*`) to invalidate multiple related caches if necessary.

- **[PERF-003] Read/Write Replication**
  - Use `readQuery` for all read operations to hit the read-replica database.
  - Use `writeQuery` or `primaryQuery` for all mutations to hit the primary database.
  - Exception: Use `primaryQuery` for "Read-after-Write" scenarios to avoid replication lag issues.

- **[PERF-004] Index-First Design**
  - Every column used in a `WHERE`, `JOIN`, or `ORDER BY` clause must be indexed in Postgres.
  - Use `EXPLAIN ANALYZE` to verify query performance before merging large data changes.

- **[PERF-005] No Heavy Computations in SQL**
  - Avoid complex calculations or string manipulations in Postgres. Perform data formatting and logic in the Node.js application layer.

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

## Required Checks

- [ ] Redis is used for heavy read endpoints.
- [ ] Cache is invalidated on data updates.
- [ ] `readQuery` vs `writeQuery` is used correctly.
- [ ] No `SELECT *` is used; only required columns are fetched.
- [ ] Queries are optimized with proper indices.

## When to Use
- Use when: [trigger condition]
- NOT for: [exclusion]

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| I can skip this | Following the defined process prevents regressions |

## Red Flags
- Observable signs that this skill is being violated.

## Verification
After completing the skill, confirm:
- [ ] The process was followed correctly.
- [ ] Required outcomes are met.
