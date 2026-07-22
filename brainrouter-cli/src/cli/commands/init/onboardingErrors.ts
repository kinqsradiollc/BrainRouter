/**
 * Safe, bounded presentation for setup failures. Onboarding touches provider
 * configuration and project files, so exception text must not echo credentials
 * or terminal control sequences into the interactive shell.
 */

const MAX_INPUT_CHARS = 8_192;
const MAX_OUTPUT_CHARS = 320;
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi;
const AUTHORIZATION_ASSIGNMENT = /\b(Authorization\s*[:=]\s*)(?:(Bearer|Basic)\s+)?[^\s,;]+/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const SECRET_NAMES = [
  'api[-_]?key',
  'access[-_]?token',
  'refresh[-_]?token',
  'account[-_]?key',
  'connection[-_]?string',
  'cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'OPENAI_API_KEY',
  'BRAINROUTER_API_KEY',
].join('|');
const SECRET_ASSIGNMENT = new RegExp(
  `((?:${SECRET_NAMES})\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}\\]]+)`,
  'gi',
);
const SECRET_TOKEN = /\b(?:sk|gh[pousr]|xox[baprs])[-_][a-z0-9_-]+\b/gi;
const PRIVATE_KEY = /-----BEGIN [^-\r\n]{0,64}PRIVATE KEY-----[\s\S]*/gi;

export function safeOnboardingError(error: unknown): string {
  let raw = 'Workspace setup failed.';
  try {
    raw = error instanceof Error ? error.message : String(error);
  } catch {
    // A hostile object can throw from String(); the generic message is safer.
  }

  const cleaned = raw
    .slice(0, MAX_INPUT_CHARS)
    .replace(ANSI_ESCAPE, '')
    .replace(PRIVATE_KEY, '[REDACTED]')
    .replace(URL, '[URL]')
    .replace(
      AUTHORIZATION_ASSIGNMENT,
      (_match, prefix: string, scheme: string | undefined) => `${prefix}${scheme ? `${scheme} ` : ''}[REDACTED]`,
    )
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(SECRET_TOKEN, '[REDACTED]')
    .replace(CONTROL_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'Workspace setup failed.';
  if (cleaned.length <= MAX_OUTPUT_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_OUTPUT_CHARS - 3)}...`;
}
