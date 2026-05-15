---
name: auth-skill
description: Identity, JWT rules, and "Kill Switch" logic for [PROJECT_NAME] authentication.
---

# Authentication & Security Skill

This skill governs the identity and session lifecycle of [PROJECT_NAME]. Failure to adhere to these rules results in an automatic security violation `[SEC-202]`.

## Rules (MUST FOLLOW)

- **[AUTH-001] JWT Payload Hygiene**
  - Only include: `sub` (userId), `sid` (sessionId), `role`, and `exp`.
  - **Never** include: Email, full name, phone number, or any other PII in the JWT.

- **[AUTH-002] Passkey Lifecycle**
  - Use `@simplewebauthn/server` for all WebAuthn flows.
  - Registration: Verify `challenge` and `origin`.
  - Authentication: Verify `counter` to detect cloned authenticators.

- **[AUTH-003] The "Kill Switch" Mechanism**
  - If a user changes their password, all active sessions (`user_sessions` table) must be deleted.
  - Admins can revoke any session by `sessionId` which must immediately block the associated Access Token via Redis blacklist.

- **[AUTH-004] Brute-Force Shield**
  - Apply `redisRateLimit` to all Auth routes.
  - Failed attempts should have exponential backoff where possible.

## Implementation Details

### Session Revocation Pattern
When revoking a session, perform these steps:
1. Delete row from `user_sessions`.
2. Add `sid` to Redis `revoked_sessions` set with a TTL matching the remaining JWT expiry.
3. Middleware `requireAuth` must check this Redis set on every request.

## Required Checks

- [ ] JWT contains minimal data.
- [ ] `redisRateLimit` is present.
- [ ] Password reset invalidates all tokens.
- [ ] Passkey counter is verified.
- [ ] Refresh tokens are in `httpOnly` cookies.
