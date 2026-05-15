# Security Policy

This repository handles production user data and privileged database access. Treat security requirements as **non-optional**. These rules are machine-readable and will be enforced by AI agents during development and PR review.

## 🛡️ Core Rules (AI Enforced)

### 🔑 Credentials & Secrets
- **[SEC-001] No Hardcoded Secrets**: Never commit database passwords, JWT secrets, API keys, or service account credentials.
- **[SEC-002] Environment Variable Scoping**: Only variables prefixed with `NEXT_PUBLIC_` are allowed in client-side code. All others must remain server-side.
- **[SEC-003] Secret Rotation**: Any exposed secret must be rotated within 1 hour of discovery.

### 💉 Injection & Sanitization
- **[SEC-101] No Raw Queries**: Always use parameterized queries or ORM methods. Never use string concatenation to build SQL.
- **[SEC-102] XSS Prevention**: All user-generated content (e.g., Stories, Bios) must be sanitized before being rendered. Prefer React's default escaping; use `DOMPurify` for HTML.
- **[SEC-103] Input Validation**: Every API endpoint must have a Zod schema validating 100% of the input surface area.

### 👤 Identity & Access
- **[SEC-201] derived User Identity**: Never trust `user_id` or `role` from request bodies. Always derive identity from the verified JWT/Session in `req.user`.
- **[SEC-202] Secure Session Cookies**: Refresh tokens must use `httpOnly`, `Secure`, and `SameSite=Strict` flags.
- **[SEC-203] RBAC Enforcement**: Admin-only routes must use the `requireAdmin` middleware which performs a database-level role check.

### 📦 Data & Dependencies
- **[SEC-301] PII Masking**: Never log full email addresses, phone numbers, or passwords. Use `maskEmail()` or similar utilities in logs.
- **[SEC-302] Dependency Auditing**: Run `npm audit` weekly. Critical/High vulnerabilities must be patched immediately.
- **[SEC-303] Secure Headers**: Every response must include `X-Content-Type-Options: nosniff` and a strict `Content-Security-Policy`.

---

## 🛠️ Architectural Guardians

### The "Security Shield" Pattern
Every new API route must implement the following "Shield" in order:
1. **Rate Limiting**: Defend against brute force.
2. **Authentication**: Verify the caller.
3. **Authorization**: Check permissions.
4. **Validation**: Sanitize the data.

### Database Hardening
- Direct database writes from client code are strictly forbidden.
- Use the `readQuery` vs `writeQuery` pattern to support read replicas while ensuring data integrity on the primary.

---

## 🤖 AI Agent Review Protocol

When reviewing a Pull Request, AI agents must:
1. Scan for `[SEC-xxx]` compliance.
2. If a violation is found, comment with the Rule ID and required fix.
3. Block merge if any `Critical` rules (SEC-001, SEC-101, SEC-201) are violated.

---

## 🚨 Incident Response
If a security vulnerability or secret exposure is detected:
1. **Kill Switch**: Use the Admin dashboard to revoke sessions or deactivate impacted accounts.
2. **Rotate**: Update environment variables in production immediately.
3. **Audit**: Use `GET /api/admin/audit-logs` to trace the impact.
4. **Review**: Refer to the [Authentication Skill](../../../skills/api/auth-skill/SKILL.md) for session revocation technicals.