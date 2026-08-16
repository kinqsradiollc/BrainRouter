/**
 * Shared source-safety policy for every review front door.
 *
 * A working-tree diff is local data, but it still crosses a model boundary.
 * Credential-bearing paths and opaque binary patches are therefore excluded
 * from model context and reported as unavailable coverage. Text that remains
 * is redacted without changing its line count so evidence-derived positions
 * continue to refer to the original diff lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeReviewPath, splitUnifiedDiffFiles } from './reviewBundles.js';

/**
 * Directories whose contents are credentials rather than code.
 *
 * `.git` belongs here for a reason that is easy to miss: `.git/config` carries
 * remote URLs, and a remote cloned with a token embeds it —
 * `https://x-access-token:ghp_…@github.com/owner/repo`. So the one directory
 * guaranteed to exist in every repository we review is also one that routinely
 * holds a live credential. `.git/credentials` and the packed refs are the same
 * shape of problem.
 *
 * The review path does not reach it today — reads are bounded to the diff's file
 * inventory and opened `O_NOFOLLOW` — so this is defence in depth rather than a
 * live hole. It is here because a denylist that names `.aws` and `.ssh` while
 * omitting `.git` reads as an oversight to the next person, and because the
 * inventory is not the only caller this predicate will ever have.
 */
const SENSITIVE_DIRECTORIES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.yarnrc.yml',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'service-account.json',
  'service_account.json',
]);

const KEY_MATERIAL_EXTENSIONS = new Set([
  'jks',
  'key',
  'keystore',
  'p12',
  'pem',
  'pfx',
]);

const SECRET_CONFIG_EXTENSIONS = new Set([
  'env',
  'ini',
  'json',
  'properties',
  'toml',
  'yaml',
  'yml',
]);

const SINGLE_LINE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]'],
  [/Basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/\b(?:Set-)?Cookie:[ \t]*\S[^\r\n]*/gi, 'Cookie: [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED]'],
  [/\bgh[posru]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED]'],
  [/\b(?:postgres|postgresql|mongodb|mysql|mongodb\+srv|redis|sqlite):\/\/[^:\s]+:[^@\s]+@[^\s]+\b/gi, '[REDACTED_CONN_STR]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]'],
  [/\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b/g, '[REDACTED_IP]'],
  [/(\b(?:api[_-]?key|access[_-]?token|authorization|client[_-]?secret|password|passwd|secret|token)\b\s*[:=]\s*)(["'])[^"']{6,}\2/gi, '$1$2[REDACTED]$2'],
  [/^([+\- ]?[ \t]*[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*)\S{6,}.*$/gi, '$1[REDACTED]'],
  [/^([+\- ]?[ \t]*(?:api[_-]?key|client[_-]?secret|password|passwd|secret|token)[ \t]*:[ \t]*)[A-Za-z0-9._~+/=-]{6,}[ \t]*$/gi, '$1[REDACTED]'],
];

export const SENSITIVE_REVIEW_SOURCE_REASON =
  'the requested path is credential-bearing or otherwise excluded by the review source policy';

/** True when a repo-relative path is too likely to contain credentials to read. */
export function isSensitiveReviewSourcePath(value: string): boolean {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/').toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  const base = segments.at(-1) ?? '';
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (KEY_MATERIAL_EXTENSIONS.has(extension)) return true;
  return SECRET_CONFIG_EXTENSIONS.has(extension)
    && /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/.test(base);
}

/**
 * Apply the baseline review redactor without adding or removing newlines.
 * Private-key blocks are handled line-by-line so a pasted key cannot evade
 * redaction merely because it appears in an otherwise ordinary source file.
 */
export function redactReviewSourceText(value: string): string {
  let inPrivateKey = false;
  return String(value ?? '').split('\n').map((line) => {
    const beginsPrivateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line);
    const endsPrivateKey = /-----END [A-Z ]*PRIVATE KEY-----/.test(line);
    if (beginsPrivateKey || inPrivateKey) {
      const prefix = /^[+\- ]/.test(line) ? line[0] : '';
      inPrivateKey = !endsPrivateKey;
      return `${prefix}[REDACTED_PRIVATE_KEY]`;
    }
    return SINGLE_LINE_REDACTIONS.reduce(
      (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
      line,
    );
  }).join('\n');
}

export interface BoundedReviewSourceText {
  text: string;
  truncated: boolean;
}

/**
 * Read one regular workspace file through the same hard boundary as reviewer
 * tools: repo-relative only, no symlink component, byte-bounded before decode,
 * sensitive-path denied, and redacted before the text can reach a model.
 */
export function readBoundedReviewSourceText(
  workspaceRoot: string,
  relativePath: string,
  maxBytes = 256 * 1024,
): BoundedReviewSourceText | null {
  const raw = String(relativePath ?? '');
  if (
    !workspaceRoot
    || !raw.trim()
    || raw.startsWith('/')
    || /^[A-Za-z]:/.test(raw)
    || raw.includes('\\')
    || /[\u0000\r\n]/.test(raw)
  ) return null;
  const normalized = normalizeReviewPath(raw);
  const segments = normalized.split('/');
  if (
    !normalized
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || isSensitiveReviewSourcePath(normalized)
  ) return null;

  const limit = Math.max(1, Math.min(4 * 1024 * 1024, Math.trunc(maxBytes) || 1));
  let root: string;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch {
    return null;
  }
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  let cursor = root;
  try {
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    if (!fs.statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const buffer = Buffer.allocUnsafe(limit + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const truncated = bytesRead > limit;
    let end = Math.min(bytesRead, limit);
    while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return {
      text: redactReviewSourceText(buffer.subarray(0, end).toString('utf8')),
      truncated,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface PreparedReviewDiffSource {
  /** Text-only, path-filtered, line-preservingly redacted model context. */
  diff: string;
  /** Paths intentionally withheld from model context and review coverage. */
  excludedPaths: string[];
  /** File sections present before source-safety filtering. */
  totalFiles: number;
  /** Whether at least one retained text section contained redacted content. */
  redacted: boolean;
}

/** Prepare an untrusted unified diff before it reaches any review model. */
export function prepareReviewDiffSource(value: string): PreparedReviewDiffSource {
  const sections = splitUnifiedDiffFiles(value).filter((file) => file.diff.trim().length > 0);
  const retained: string[] = [];
  const excludedPaths: string[] = [];
  let redacted = false;
  for (const section of sections) {
    const opaque = /^(?:GIT binary patch|Binary files .+ differ)$/m.test(section.diff);
    const sectionPaths = [section.oldPath, section.path].filter((path): path is string => Boolean(path));
    if (sectionPaths.some(isSensitiveReviewSourcePath) || opaque) {
      excludedPaths.push(...sectionPaths);
      continue;
    }
    const safe = redactReviewSourceText(section.diff);
    redacted ||= safe !== section.diff;
    retained.push(safe);
  }
  return {
    diff: retained.join('\n'),
    excludedPaths: [...new Set(excludedPaths)].sort(),
    totalFiles: sections.length,
    redacted,
  };
}
