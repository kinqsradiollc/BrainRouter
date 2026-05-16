---
name: testing-skill
description: Supertest, Vitest, and Shield verification standards for.
---

# Testing Skill

## Overview

This skill ensures every feature is robust, regression-free, and secure. All new features **must** include tests that follow these rules.

## Workflow

- **[TEST-001] Security Shield Verification**
  - Integration tests must verify the entire "Security Shield":
    - Confirm 401 when unauthenticated.
    - Confirm 403 when lacking proper roles.
    - Confirm 429 when rate limits are exceeded (use mocks to speed up).
    - Confirm 400 when Zod validation fails.

- **[TEST-002] Mandatory Mocking**
  - Never run tests against a live production database.
  - Mock all database calls (`readQuery`, `writeQuery`, `primaryQuery`) using `vi.mock`.
  - Mock external services (Storage, Email, Redis).

- **[TEST-003] Response Schema Consistency**
  - Use `expect.objectContaining` or snapshots to ensure API responses match the documentation in `API.md`.

- **[TEST-004] Error Case Coverage**
  - Tests must cover 100% of the `catch` blocks and conditional error returns (404, 409, etc.).

## Implementation Pattern (Vitest + Supertest)

```typescript
import request from 'supertest';
import { vi, describe, it, expect } from 'vitest';
import app from '../../app';
import { query } from '../../database/connection';

vi.mock('../../database/connection');

describe('POST /api/v1/resource', () => {
  it('should reject unauthenticated requests [TEST-001]', async () => {
    const response = await request(app).post('/api/v1/resource').send({});
    expect(response.status).toBe(401);
  });

  it('should validate input using Zod [TEST-001]', async () => {
    const response = await request(app)
      .post('/api/v1/resource')
      .set('Authorization', 'Bearer valid_token')
      .send({ invalid: 'data' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
```

## Required Checks

- [ ] Security Shield is fully tested (Auth, Rate Limit, Validation).
- [ ] Database and External Services are mocked.
- [ ] 100% of error paths are exercised.
- [ ] Snapshots or object matching verify response structure.

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
