---
name: testing-skill
description: Mocking strategies, assertion standards, integration testing, and test coverage rules. Use when writing tests for new features, bug fixes, API endpoints, or core library integrations.
hints: |
  - Write tests alongside or immediately after implementing code to verify behavioral paths.
  - Mock all external dependencies (e.g. databases, Redis caches, email services, third-party APIs).
  - Verify security barriers, including authentication blocks, permission levels, and validation errors.
  - Enforce strict response schema checks using object matching or JSON schema snapshots.
  - Target 100% path coverage for error handling branches and catch blocks.
---

# Testing Skill

## Overview

This skill ensures that every codebase feature is robust, regression-free, secure, and easily verifiable. All new features and endpoints must incorporate corresponding unit or integration tests that validate both standard success operations and failure boundaries.

## Workflow

- **[TEST-001] Security Shield Verification**
  - Integration tests must verify the entire request-handling ingress pipeline:
    - Confirm `401 Unauthorized` responses when requests are unauthenticated.
    - Confirm `403 Forbidden` responses when requests lack required roles.
    - Confirm `429 Too Many Requests` when rate limits are exceeded (using mocks to accelerate testing).
    - Confirm `400 Bad Request` when structural input validation (e.g., Zod, Joi) fails.

- **[TEST-002] Mandatory Mocking**
  - Never run unit or integration tests against a live production database or external system.
  - Mock all database querying layers (such as `readQuery`, `writeQuery`, or ORM functions) using mock injection systems.
  - Mock all external integrations, including Cloud storage, email transmitters, and Redis cache clusters.

- **[TEST-003] Response Schema Consistency**
  - Ensure API responses precisely match active specifications using `expect.objectContaining` or json-schema snapshot comparisons.

- **[TEST-004] Error Case Coverage**
  - Exercise failure branches. Tests must cover `catch` blocks, invalid formats, entity-not-found exceptions, and rate limit occurrences.

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

---

## When to Use

- Implementing new backend routes, controllers, or service logic.
- Resolving bugs, where a regression-preventing test should be added.
- Modifying critical authentication, security, or routing middlewares.
- Restructuring core data-fetching models or database connectors.

**When NOT to use:**
- Updating documentation files (`README.md`, `walkthrough.md`) or configuration comments.
- Working on local scratch files, design assets, or styling-only UI adjustments.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The feature is too simple to test." | Simple features aggregate. Without automated test verification, basic structural regressions occur when global layouts or database models change. |
| "Writing mocks is too slow and tedious." | Live database connections in tests cause flaky, slow, and environment-dependent builds. Mocks guarantee stable, ultra-fast test execution. |
| "I'll add test coverage in a subsequent PR." | Post-hoc testing rarely happens due to shifting priorities. Features without automated proof of success are considered incomplete. |

## Red Flags

- Tests that require a live, external internet connection or local database instance to pass.
- Bypassing input validation or authorization middleware checks in integration tests.
- High test coverage metrics that only assert success paths while completely skipping failure scenarios.
- Suppressing uncaught exceptions or console errors inside active test suites.

## Verification

After completing the test suite implementation, verify:
- [ ] Automated test suite runs synchronously and passes without flakiness or timeout warnings.
- [ ] Security boundaries (401 Unauthorized, 400 Bad Request) are explicitly tested.
- [ ] Database interfaces and external API calls are verified as 100% mocked.
- [ ] Response structures match specifications precisely.
- [ ] Test coverage reports are generated and confirm error path traversal.
