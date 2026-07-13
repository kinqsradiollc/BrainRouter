// Each pattern targets a specific secret format.
// All patterns use the /g flag so String.replace replaces all occurrences per call.
// The array is module-level (not re-created per call) — safe because .replace() does
// not mutate lastIndex on string arguments.
const REDACTION_PATTERNS: [RegExp, string][] = [
  // HTTP Authorization: Bearer <token>
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]"],
  // HTTP Authorization: Basic <base64(user:pass)> — the lookahead requires a
  // digit/+/=// so ordinary prose ("Basic understanding") is NOT redacted.
  [/Basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g, "[REDACTED]"],
  // JWTs / session tokens (header.payload.signature) — the shape a pentest PoC
  // most often captures from an auth/session finding.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]"],
  // Cookie / Set-Cookie header values (may carry a session id).
  [/\b(?:Set-)?Cookie:[ \t]*\S[^\r\n]*/gi, "Cookie: [REDACTED]"],
  // OpenAI-style secret keys (sk-...) and Stripe live/test keys (sk_live_/sk_test_)
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "[REDACTED]"],
  // GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_ and fine-grained github_pat_)
  [/\bgh[posru]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  // AWS access key ids, Google API keys, Slack tokens
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[REDACTED]"],
  // PEM private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  // Database connection strings (Postgres, MongoDB, MySQL, Redis, SQLite).
  [/\b(?:postgres|postgresql|mongodb|mysql|mongodb\+srv|redis|sqlite):\/\/[^:\s]+:[^@\s]+@[^\s]+\b/gi, "[REDACTED_CONN_STR]"],
  // IPv4 addresses can expose infrastructure details.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
  // IPv6 addresses (≥3 colon groups, so an HH:MM:SS timestamp is not matched).
  [/\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b/g, "[REDACTED_IP]"],
  // .env-style assignments: API_KEY=... SECRET=... — require ≥6 chars in value to
  // avoid over-redacting innocuous env vars like RETRY_COUNT=3 or LOG_LEVEL=info.
  [/^[ \t]*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*\S{6,}.*$/gim, "[REDACTED]"],
];

export function redactSensitiveMemoryText(text: string): string {
  return REDACTION_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
