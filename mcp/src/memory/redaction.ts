const REDACTION_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /^[ \t]*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*.+$/gim,
];

export function redactSensitiveMemoryText(text: string): string {
  return REDACTION_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), text);
}
