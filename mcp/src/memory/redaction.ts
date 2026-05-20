// Each pattern targets a specific secret format.
// All patterns use the /g flag so String.replace replaces all occurrences per call.
// The array is module-level (not re-created per call) — safe because .replace() does
// not mutate lastIndex on string arguments.
const REDACTION_PATTERNS: [RegExp, string][] = [
  // HTTP Authorization: Bearer <token>
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]"],
  // OpenAI-style secret keys (sk-...)
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  // GitHub personal access tokens (ghp_...)
  [/\bghp_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]"],
  // PEM private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  // Database connection strings (Postgres, MongoDB, MySQL, Redis, SQLite).
  [/\b(?:postgres|postgresql|mongodb|mysql|mongodb\+srv|redis|sqlite):\/\/[^:\s]+:[^@\s]+@[^\s]+\b/gi, "[REDACTED_CONN_STR]"],
  // IPv4 addresses can expose infrastructure details.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
  // .env-style assignments: API_KEY=... SECRET=... — require ≥6 chars in value to
  // avoid over-redacting innocuous env vars like RETRY_COUNT=3 or LOG_LEVEL=info.
  [/^[ \t]*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*\S{6,}.*$/gim, "[REDACTED]"],
];

export function redactSensitiveMemoryText(text: string): string {
  return REDACTION_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
