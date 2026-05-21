---
name: api-skill
description: Mandatory middleware, validation boilerplate, error safe-listing, and performance rules for fast, consistent, and secure endpoints.
hints: |
  - Verify existing API routes, schemas, and specs in the project before drafting new endpoints.
  - Implement a strong validation layer (e.g. Zod, Joi) covering all incoming body, query, and path parameters.
  - Apply security middleware, rate-limiting, and authentication gates to all non-public endpoints.
  - Safe-list user-visible errors and never leak database stack traces or internal secrets to the client.
  - Optimize query performance by selecting explicit columns and using cursor-based pagination for lists.
---

# API Standards Skill

## Overview

This skill ensures every network endpoint is fast, consistent, secure, and well-designed. Standardizing input validation, error mapping, rate limiting, and database interactions prevents security vulnerabilities and performance bottlenecks at the entry point of the application.

## Workflow

### 1. Document & Align Check
Before crafting or modifying any endpoint, review the project's active API specification files (e.g., `API.md`, `openapi.yaml`, or `docs/api/`). Ensure your endpoints adhere exactly to the defined naming schemes, payload structures, and architectural standards.

### 2. Implement the "Security Shield" Ingress
Use the following pattern for every new route to guarantee input hygiene, authentication, and rate limiting:

```typescript
import { Request, Response } from 'express';
import { z } from 'zod';
import { redisRateLimit } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/auth';
import { sendSuccess, ErrorResponses } from '../../utils/response';

// 1. Define Input Schema
const InputSchema = z.object({
  id: z.string().uuid(),
  // ... other fields
});

export const myNewEndpoint = [
  // 2. Apply Rate Limit
  redisRateLimit({ windowMs: 60000, max: 10 }), 
  
  // 3. Authenticate
  requireAuth, 
  
  async (req: Request, res: Response) => {
    try {
      // 4. Validate Input
      const data = InputSchema.parse(req.body);
      
      // 5. Derive Identity
      const userId = req.user.id; 

      // ... Business Logic ...

      return sendSuccess(res, { result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return ErrorResponses.badRequest(res, 'Invalid input', 'VALIDATION_ERROR');
      }
      console.error('API Error:', error);
      return ErrorResponses.internalError(res);
    }
  }
];
```

## Error Safe-Listing

Map all internal system errors to secure, generic client-facing errors. Never leak raw database queries, connection failures, or environment details.

| Internal Code / Error Type | HTTP Status | Visible to Client? | Exposed Client Code |
|---|---|---|---|
| `ZodError` / Input validation | 400 Bad Request | Yes (with field details) | `VALIDATION_ERROR` |
| Missing Session Token / Expired | 401 Unauthorized | Yes | `AUTH_REQUIRED` |
| Insufficient Permissions / Roles | 403 Forbidden | Yes | `FORBIDDEN` |
| Database Entity Missing | 404 Not Found | Yes | `NOT_FOUND` |
| Raw Database Exception (`DB_ERROR`) | 500 Internal Error | **NO** | `INTERNAL_ERROR` |
| Third-Party API Failure | 500 Internal Error | **NO** | `INTERNAL_ERROR` |

---

## Performance Rules

- **No `SELECT *`**: Always explicitly select the required columns. Scanning and returning unused database fields wastes database memory and network bandwidth.
- **Cursors Only**: Use cursor-based keys (`before`/`after` or comparable token indices) for list pagination. Avoid `OFFSET` pagination, which degrades rapidly as tables grow.
- **Cache-Aside Pattern**: Wrap resource-intensive, read-heavy query operations (like listings, configs, or stats) in cached gets/sets (e.g., Redis) with explicit TTLs.

---

## When to Use

- Implementing new REST, GraphQL, or RPC endpoints in backend routers.
- Modifying existing request/response structures or validation schemas.
- Refactoring data fetch APIs, database pagination, caching logic, or error handling.

**When NOT to use:**
- Internal utility functions, helper libraries, or offline CLI commands that do not expose public network endpoints.
- Developing pure client-side markup or styling layout elements.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add validation and security middlewares later." | Security and input validation are baseline requirements, not post-implementation decorations. Out-of-order security leads to leaked data. |
| "Leaking internal stack traces helps me debug faster in staging." | Stack traces and DB messages leak structural details about database models, schemas, and packages, giving attackers vectors to exploit. |
| "Offset pagination is easier to implement." | Offset pagination (`LIMIT/OFFSET`) scales poorly. As datasets grow, the database must scan millions of rows to discard them, causing severe latency degradation. |

## Red Flags

- Request handler reading raw untrusted `req.body` variables without structural validation.
- Database query executing `SELECT *` or lack of explicit select fields.
- Returning raw server errors or database exceptions directly in JSON response blocks.
- Pagination endpoints that do not accept cursor boundaries or rely solely on page offsets.

## Verification

After completing the API endpoint, verify:
- [ ] Route uses the "Security Shield" pattern (Rate limits, Authentication, Validation).
- [ ] Zod or equivalent validation schemas strictly validate all parameters (body, query, params).
- [ ] Malformed or invalid payloads return safe `VALIDATION_ERROR` responses with 400 statuses.
- [ ] System logs stack traces on exceptions, but clients receive a generic `INTERNAL_ERROR` 500 status.
- [ ] Large list responses enforce cursor-based pagination and select explicit database columns.
