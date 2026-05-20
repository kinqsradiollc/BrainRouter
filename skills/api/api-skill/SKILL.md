---
name: api-skill
description: Mandatory middleware and validation boilerplate for fast, consistent, and secure endpoints.
---

# API Standards Skill

## Overview

This skill ensures every endpoint is fast, consistent, and secure.

## Workflow

### 0️⃣ Mandatory Documentation Check
Before crafting or modifying any endpoint, you **must** run `list_template_docs` and use `get_template_doc` to retrieve any project-specific API documentation (e.g., from `docs/api`). Your API design must adhere exactly to the defined schemas and conventions in the living documentation.

### 🛡️ The "Security Shield" Boilerplate

New developers **must** use this pattern for every new route. AI agents will reject any PR missing these components.

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
  // 2. Apply Rate Limit [SEC-303]
  redisRateLimit({ windowMs: 60000, max: 10 }), 
  
  // 3. Authenticate [SEC-201]
  requireAuth, 
  
  async (req: Request, res: Response) => {
    try {
      // 4. Validate Input [SEC-103]
      const data = InputSchema.parse(req.body);
      
      // 5. Derive Identity [SEC-201]
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

## 📋 Error Safe-Listing

| Code | Type | Visible to Client? |
|------|------|--------------------|
| `VALIDATION_ERROR` | Bad Request | Yes (Field details ok) |
| `AUTH_REQUIRED` | Unauthorized | Yes |
| `FORBIDDEN` | Permission | Yes |
| `NOT_FOUND` | Missing | Yes |
| `DB_ERROR` | Internal | **NO** (Map to INTERNAL_ERROR) |
| `S3_CONNECTION_FAIL` | Internal | **NO** (Map to INTERNAL_ERROR) |

## 🚀 Performance Rules
- **[PERF-001] No SELECT * **: Always list required columns.
- **[PERF-002] Cursors Only**: Use `encodeCursor` for all lists. No `OFFSET`.
- **[PERF-003] Cache-Aside**: Use Redis `cache.get/set` for heavy read operations (e.g., Vibe lists).

## Required Checks

- [ ] Route uses the "Security Shield" pattern.
- [ ] Zod schema covers all inputs.
- [ ] No internal system errors are leaked.
- [ ] Cursor pagination is used for lists.

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
