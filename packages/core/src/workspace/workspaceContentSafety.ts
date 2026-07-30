/**
 * High-confidence credential detection for workspace onboarding text
 * for assisted setup. Repository evidence and model-authored instruction
 * drafts cross a model boundary, so callers fail closed on recognizable secret
 * material instead of attempting partial redaction. This detector is pure and
 * intentionally shared by scan input and proposal-output validation.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:br_[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9._-]{8,})\b/,
  /\b(?:gh[opusr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/,
  /\bxox[baprs]-[^\s"']{8,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\b(?:glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,})\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/=:-]{8,}/i,
  /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/i,
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@?#]+:[^\s/@?#]+@[^\s"'<>]+/i,
  /[?&#;](?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|sig|signature|token)=[^\s&#;"']{6,}/i,
];

const CREDENTIAL_ASSIGNMENT = new RegExp(
  [
    '(?:^|[^A-Za-z0-9_])',
    '(?:[A-Za-z0-9]+[_-])*',
    '(?:api[_-]?key|account[_-]?key|client[_-]?secret|secret(?:[_-]access)?[_-]key|',
    'secret|password|passwd|token|access[_-]?token|refresh[_-]?token|',
    'authorization|bearer|auth(?:orization)?[_-]?token|private[_-]?key|',
    'database[_-]?url)',
    '\\s*["\']?\\s*[:=]\\s*["\']?',
    '(?!\\s*(?:\\$\\{|(?:process|deno|request|req|config|options|input|env)\\.|',
    'os\\.getenv\\b|getenv\\s*\\(|<|(?:example|placeholder|changeme|redacted)\\b|your[_-]))',
    '[^\\s,"}]{6,}',
  ].join(''),
  'im',
);

// A byte cap can stop immediately before the `@host` suffix that distinguishes
// URL userinfo from an ordinary URL. Only apply this suffix check to truncated
// evidence so stable host:port URLs retain their existing low-false-positive path.
const TRUNCATED_URI_USERINFO = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@?#]+:[^\s/@?#]+@?$/i;

export interface WorkspaceSecretMaterialOptions {
  truncated?: boolean;
}

/** True when text contains credential material that must not cross onboarding boundaries. */
export function containsWorkspaceSecretMaterial(
  content: string,
  options: WorkspaceSecretMaterialOptions = {},
): boolean {
  if (!content) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(content)) ||
    CREDENTIAL_ASSIGNMENT.test(content) ||
    (options.truncated === true && TRUNCATED_URI_USERINFO.test(content));
}
