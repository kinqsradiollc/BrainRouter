---
name: auth-skill
description: Identity, JWT rules, session management, and security logic for authentication. Use when building or modifying login, registration, password resets, token generation, or authentication middlewares.
hints: |
  - Ensure JWT payloads remain clean of any Personally Identifiable Information (PII).
  - Verify WebAuthn/Passkey signatures, origins, and authenticator counters strictly.
  - Implement a session "Kill Switch" that blacklists active session IDs on password changes.
  - Enforce httpOnly, secure, and sameSite cookie attributes for refresh tokens.
  - Apply brute-force protection using rate limiters on all authentication and password reset routes.
---

# Authentication & Security Skill

## Overview

This skill governs the identity, session, and credential lifecycle of users. Authentication is the primary security gate of the application; failure to adhere to these rules results in severe security vulnerabilities `[SEC-202]`.

## Workflow

- **[AUTH-001] JWT Payload Hygiene**
  - Only include: `sub` (userId), `sid` (sessionId), `role`, and `exp`.
  - **Never** include: Email, full name, phone number, or any other Personally Identifiable Information (PII) in the JWT.

- **[AUTH-002] Passkey Lifecycle**
  - Use `@simplewebauthn/server` or an equivalent secure library for all WebAuthn flows.
  - Registration: Verify `challenge` and matching hostname `origin`.
  - Authentication: Verify the signature and ensure the `counter` is strictly incrementing to detect cloned authenticators.

- **[AUTH-003] The "Kill Switch" Mechanism**
  - If a user changes their password or requests "Log out from all devices," all active sessions (`user_sessions` table) must be immediately deleted.
  - Admins can revoke any session by `sessionId`, which must immediately block the associated Access Token via a real-time Redis blacklist.

- **[AUTH-004] Brute-Force Shield**
  - Apply `redisRateLimit` or standard IP rate-limiting to all Auth routes (login, register, password reset).
  - Failed attempts should trigger exponential backoff to prevent automated dictionary attacks.

## Implementation Details

### Session Revocation Pattern
When revoking a session, perform these steps:
1. Delete the row from the active sessions table (e.g., `user_sessions`).
2. Add `sid` to a Redis `revoked_sessions` set with a TTL matching the remaining JWT expiry.
3. Middleware `requireAuth` must check this Redis set on every request to block revoked but not-yet-expired tokens.

---

## When to Use

- Building or modifying authentication systems (OAuth, standard login/signup, Passkeys/WebAuthn).
- Designing session lifecycles, refresh token rotations, or JWT signing strategies.
- Setting up access control gates, route guards, and identity middlewares.
- Implementing password recovery, email verification, or account deletion flows.

**When NOT to use:**
- Internal communications between microservices inside a secure VPC where authentication is managed at the network or service-mesh layer.
- Static client-side routing where page access control is handled solely as a UX/UI enhancement rather than a security boundary.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Storing the user email in the JWT makes it easy to read in the frontend." | JWTs are base64-encoded, not encrypted. Storing emails or names in a JWT exposes PII to anyone inspecting the token, violating data privacy regulations. |
| "A session table is enough; we don't need real-time revocation checking." | Access tokens (JWTs) remain valid until they expire. Without a real-time Redis blacklist or short-lived token validation, active attackers cannot be locked out. |
| "I'll store the refresh token in LocalStorage for simplicity." | Storing session secrets in LocalStorage makes them fully accessible to cross-site scripting (XSS) attacks. Refresh tokens must only live in httpOnly cookies. |

## Red Flags

- Refresh tokens stored in standard cookies without `httpOnly: true` or `secure: true` attributes.
- Storing full names, phone numbers, or passwords inside JWT payload bodies.
- Failing to increment or verify WebAuthn authenticator counters during Passkey authentication.
- Auth endpoints (login, register, reset) that do not enforce active rate-limiting middleware.

## Verification

After completing the authentication setup, verify:
- [ ] JWT payloads are inspected and confirm they only contain non-sensitive identifiers (`sub`, `sid`, `role`, `exp`).
- [ ] Password resets successfully revoke all active database sessions and invalidate outstanding access tokens.
- [ ] Refresh tokens are confirmed to be delivered via secure, httpOnly, sameSite cookies.
- [ ] Brute-force requests against auth endpoints are actively blocked by rate limiters.
- [ ] WebAuthn registration/authentication processes verify signatures, origins, and anti-cloning counters.
