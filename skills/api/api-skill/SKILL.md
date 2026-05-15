---
name: api-skill
description: Mandatory middleware and validation boilerplate for fast, consistent, and secure [PROJECT_NAME] endpoints.
---

# API Standards Skill

## Overview

This skill ensures every [PROJECT_NAME] endpoint is fast, consistent, and secure.

## Workflow

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
