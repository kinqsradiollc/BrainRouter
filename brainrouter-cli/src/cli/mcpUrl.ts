/**
 * Credential-safe MCP endpoint and command handling for BrainRouter CLI (0.4.17).
 *
 * Centralizes HTTP validation plus URL/stdio editing, redaction, and logout
 * sanitization so setup and error surfaces never expose saved or legacy inline
 * credentials. Parsing and decoding are bounded; unsafe URL material fails
 * validation, and editable projections return empty instead of prefilling a secret.
 */
import type { Config, ServerConfig } from '@kinqs/brainrouter-core/config';

const SENSITIVE_QUERY_PARTS = [
  'apikey',
  'accesskey',
  'privatekey',
  'secretaccesskey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'authorization',
  'credential',
  'password',
  'passwd',
  'secret',
  'token',
  'signature',
  'connectionstring',
  'databaseurl',
  'dsn',
  'cookie',
];
const MCP_HTTP_URL_MAX_BYTES = 16 * 1024;
export const MCP_ERROR_TEXT_MAX_CHARS = 16 * 1024;
const MCP_ERROR_EXACT_CREDENTIAL_MAX_CHARS = 1024 * 1024;
const MCP_ERROR_EXACT_CREDENTIAL_MAX_VALUES = 512;
const MCP_ERROR_EXACT_CREDENTIAL_MAX_TOTAL_CHARS = 2 * 1024 * 1024;
const MCP_ERROR_CONFIG_SERVER_MAX_COUNT = 128;
const MCP_ERROR_CONFIG_ENTRY_MAX_COUNT = 256;
const MCP_ERROR_STDIO_ARG_MAX_COUNT = 1_024;
const MAX_PERCENT_DECODE_PASSES = 8;
const MCP_ERROR_TRUNCATION_MARKER = ' … [truncated]';
const SENSITIVE_STDIO_SHORT_OPTIONS = new Set(['k', 'p', 's', 't']);
const MCP_ERROR_CREDENTIAL_ASSIGNMENTS = [
  'authorization',
  'api[-_ ]?key',
  'access[-_ ]?token',
  'refresh[-_ ]?token',
  'client[-_ ]?secret',
  'password',
  'passwd',
  'credential',
  'signature',
  'cookie',
].map((label) => new RegExp(
  `(\\b${label}[ \\t]{0,256}[:=][ \\t]{0,256})[^\\s,;]{1,65536}`,
  'gi',
));

function normalizeParameterName(name: string): string {
  let decoded = name;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveCredentialName(name: string): boolean {
  const normalized = normalizeParameterName(name);
  return normalized === 'key'
    || normalized === 'sig'
    || normalized === 'auth'
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('connectionstring')
    || normalized.endsWith('databaseurl')
    || normalized.endsWith('signature')
    || SENSITIVE_QUERY_PARTS.some((part) => normalized === part || normalized.endsWith(part));
}

function isSensitiveStdioCredentialOptionName(name: string): boolean {
  const normalized = normalizeParameterName(name.replace(/^-+/, ''));
  return SENSITIVE_STDIO_SHORT_OPTIONS.has(normalized)
    || isSensitiveCredentialName(normalized);
}

function decodeUrlComponentTolerantly(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const next = decoded.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) =>
      Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8'));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function isCredentialPathLabel(segment: string): boolean {
  const normalized = normalizeParameterName(decodeUrlComponentTolerantly(segment));
  return normalized === 'key'
    || normalized === 'auth'
    || normalized === 'sig'
    || SENSITIVE_QUERY_PARTS.some((part) => normalized === part);
}

function isMcpTokenCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || character === '_'
    || character === '-';
}

interface McpTokenSpan {
  start: number;
  end: number;
}

/** Find one three-segment token without regex backtracking. */
function findMcpJwtLikeToken(text: string, from = 0): McpTokenSpan | undefined {
  let index = from;
  while (index < text.length) {
    if (!isMcpTokenCharacter(text[index]!)) {
      index += 1;
      continue;
    }
    const firstStart = index;
    while (index < text.length && isMcpTokenCharacter(text[index]!)) index += 1;
    const firstEnd = index;
    if (firstEnd - firstStart < 8 || text[index] !== '.') continue;

    const secondStart = ++index;
    while (index < text.length && isMcpTokenCharacter(text[index]!)) index += 1;
    const secondEnd = index;
    if (secondEnd - secondStart < 8 || text[index] !== '.') continue;

    const thirdStart = ++index;
    while (index < text.length && isMcpTokenCharacter(text[index]!)) index += 1;
    if (index - thirdStart >= 8) return { start: firstStart, end: index };
  }
  return undefined;
}

export function containsObviousCredentialValue(segment: string): boolean {
  const decoded = decodeUrlComponentTolerantly(segment);
  return /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-[^/]{8,}|AKIA[A-Z0-9]{16})/i.test(decoded)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|password|signature|token|secret)\s*[:=]\s*\S+/i.test(decoded)
    || findMcpJwtLikeToken(decoded) !== undefined
    || /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(decoded);
}

function looksOpaquePathCredential(segment: string): boolean {
  const decoded = decodeUrlComponentTolerantly(segment);
  return decoded.length >= 32
    && /^[A-Za-z0-9_+=.-]+$/.test(decoded)
    && /[A-Za-z]/.test(decoded)
    && /[0-9]/.test(decoded);
}

function hasSensitivePathMaterial(pathname: string): boolean {
  // Decode before splitting so encoded (and double-encoded) separators cannot
  // hide a `token/<value>` shape from proxies that decode the path later.
  const segments = decodeUrlComponentTolerantly(pathname).split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (containsObviousCredentialValue(segment)) return true;
    if (index > 0 && isCredentialPathLabel(segments[index - 1]!) && segment) return true;
  }
  return false;
}

function redactMcpPath(pathname: string): string {
  const segments = pathname.split('/');
  const redacted = segments.map((segment, index) => {
    if (!segment) return segment;
    if (containsObviousCredentialValue(segment) || looksOpaquePathCredential(segment)) return '[redacted]';
    if (index > 0 && isCredentialPathLabel(segments[index - 1]!)) return '[redacted]';
    return segment;
  }).join('/');
  // If only decoded separators revealed the secret structure, redact the
  // whole path rather than attempting to reproduce attacker-controlled bytes.
  return redacted === pathname && hasSensitivePathMaterial(pathname) ? '/[redacted]' : redacted;
}

/** Validate an MCP HTTP endpoint without allowing credentials in URL material. */
export function validateMcpHttpUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return 'URL required';
  if (Buffer.byteLength(value) > MCP_HTTP_URL_MAX_BYTES) return 'URL is too long';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'URL must use http or https';
  }
  if (parsed.username || parsed.password) {
    return 'URL must not contain credentials; use the API key field';
  }
  if (hasSensitivePathMaterial(parsed.pathname)) {
    return 'URL path appears to contain credentials; use the API key field';
  }
  for (const [key, queryValue] of parsed.searchParams) {
    if (isSensitiveCredentialName(key)) {
      return `URL query parameter "${key}" may contain credentials; use the API key field`;
    }
    if (containsObviousCredentialValue(queryValue)) {
      return 'URL query value appears to contain credentials; use the API key field';
    }
  }
  if (parsed.hash) return 'URL fragments are not supported';
  return undefined;
}

/** Canonical form persisted after validation. */
export function normalizeMcpHttpUrl(raw: string): string {
  return new URL(raw.trim()).toString();
}

/** True only for parsed loopback HTTP endpoints, never path/query substrings. */
export function isLocalMcpHttpUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Safe terminal/UI representation, including for legacy hand-edited config. */
export function redactMcpHttpUrl(raw: string | undefined): string {
  if (!raw) return '(unset)';
  if (Buffer.byteLength(raw) > MCP_HTTP_URL_MAX_BYTES) return '[invalid URL]';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[invalid URL]';
    return `${parsed.origin}${redactMcpPath(parsed.pathname)}${parsed.search ? '?[redacted]' : ''}${parsed.hash ? '#[redacted]' : ''}`;
  } catch {
    return '[invalid URL]';
  }
}

function capMcpErrorText(text: string): string {
  if (text.length <= MCP_ERROR_TEXT_MAX_CHARS) return text;
  return text.slice(0, MCP_ERROR_TEXT_MAX_CHARS - MCP_ERROR_TRUNCATION_MARKER.length)
    + MCP_ERROR_TRUNCATION_MARKER;
}

function sanitizeMcpErrorControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

function isMcpErrorUrlTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || character === '<' || character === '>'
    || character === '"' || character === "'";
}

function redactMcpErrorUrls(text: string): string {
  const parts: string[] = [];
  let copiedUntil = 0;
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 0x68 && text.charCodeAt(index) !== 0x48) {
      index += 1;
      continue;
    }
    const candidate = text.slice(index, index + 8).toLowerCase();
    const prefixLength = candidate.startsWith('https://') ? 8
      : candidate.startsWith('http://') ? 7
        : 0;
    if (prefixLength === 0) {
      index += 1;
      continue;
    }
    let end = index + prefixLength;
    while (end < text.length && !isMcpErrorUrlTerminator(text[end]!)) end += 1;
    const touchesTruncationBoundary = text.startsWith(MCP_ERROR_TRUNCATION_MARKER, end);
    parts.push(
      text.slice(copiedUntil, index),
      touchesTruncationBoundary ? '[redacted]' : redactMcpHttpUrl(text.slice(index, end)),
    );
    copiedUntil = end;
    index = end;
  }
  parts.push(text.slice(copiedUntil));
  return parts.join('');
}

function redactMcpCredentialAssignments(text: string): string {
  let redacted = text;
  for (const pattern of MCP_ERROR_CREDENTIAL_ASSIGNMENTS) {
    redacted = redacted.replace(pattern, '$1[redacted]');
  }
  return redacted;
}

/** Redact three long dot-separated token segments with one forward-only scan. */
function redactMcpJwtLikeTokens(text: string): string {
  const parts: string[] = [];
  let copiedUntil = 0;
  while (copiedUntil < text.length) {
    const span = findMcpJwtLikeToken(text, copiedUntil);
    if (!span) break;
    parts.push(text.slice(copiedUntil, span.start), '[redacted]');
    copiedUntil = span.end;
  }

  if (copiedUntil === 0) return text;
  parts.push(text.slice(copiedUntil));
  return parts.join('');
}

/**
 * Remove endpoint credentials and terminal controls from transport errors.
 * Input is capped before URL parsing and every replacement is a constant-count
 * linear scan; the final cap also prevents short-match expansion from growing
 * terminal output beyond the same fixed bound.
 */
export function redactMcpHttpUrlsInText(text: string): string {
  const bounded = capMcpErrorText(text);
  // Decode only the already-bounded window. Percent encoding is routinely
  // reflected by HTTP stacks and must not hide a URL scheme, Bearer separator,
  // or an exact configured secret from the downstream redactors.
  let redacted = sanitizeMcpErrorControls(decodeUrlComponentTolerantly(bounded))
    .replace(/\bBearer[ \t]{1,65536}[^\s,;]{4,65536}/gi, 'Bearer [redacted]');
  redacted = redactMcpErrorUrls(redacted);
  redacted = redactMcpCredentialAssignments(redacted)
    .replace(/\bsk-[A-Za-z0-9_-]{12,65536}\b/gi, '[redacted]')
    .replace(/\bgh[opusr]_[A-Za-z0-9_]{12,65536}\b/gi, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,65536}\b/gi, '[redacted]')
    .replace(/\bxox[baprs]-[^\s,;]{8,65536}\b/gi, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/gi, '[redacted]');
  redacted = redactMcpJwtLikeTokens(redacted);
  return capMcpErrorText(redacted);
}

function isStdioHeaderOption(name: string): boolean {
  const normalized = normalizeParameterName(name.replace(/^-+/, ''));
  return normalized === 'h'
    || normalized === 'header'
    || normalized === 'headers'
    || normalized === 'httpheader'
    || normalized === 'requestheader';
}

function isStdioEnvOption(name: string): boolean {
  const normalized = normalizeParameterName(name.replace(/^-+/, ''));
  return normalized === 'e' || normalized === 'env' || normalized === 'environment';
}

interface ExactCredentialBudget {
  count: number;
  totalChars: number;
}

function addExactCredentialValue(
  values: Set<string>,
  raw: string | undefined,
  budget: ExactCredentialBudget,
): void {
  if (
    raw === undefined
    || raw.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_CHARS + 2
    || values.has(raw)
    || budget.count >= MCP_ERROR_EXACT_CREDENTIAL_MAX_VALUES
    || budget.totalChars >= MCP_ERROR_EXACT_CREDENTIAL_MAX_TOTAL_CHARS
  ) return;
  const value = raw.trim();
  if (!value) return;

  const add = (candidate: string): void => {
    if (
      !candidate
      || candidate.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_CHARS
      || values.has(candidate)
      || budget.count >= MCP_ERROR_EXACT_CREDENTIAL_MAX_VALUES
      || budget.totalChars + candidate.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_TOTAL_CHARS
    ) return;
    values.add(candidate);
    budget.count += 1;
    budget.totalChars += candidate.length;
  };
  add(value);

  const unquoted = ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1).trim()
    : value;
  if (unquoted !== value) add(unquoted);

  const bearer = /^Bearer\s+(.+)$/i.exec(unquoted);
  if (bearer?.[1]) add(bearer[1].trim());
}

function collectHeaderCredentialValue(
  values: Set<string>,
  budget: ExactCredentialBudget,
  expression: string | undefined,
  following?: string,
  afterFollowing?: string,
  allowUndelimitedName = false,
): void {
  const trimmed = expression?.trim();
  if (!trimmed) return;
  const match = /^([^:=]+)\s*[:=]\s*(.*)$/s.exec(trimmed);
  const name = match?.[1]?.trim() ?? (allowUndelimitedName ? trimmed : '');
  if (!name || !isSensitiveCredentialName(name)) return;

  const inlineValue = match?.[2]?.trim() ?? '';
  if (/^Bearer$/i.test(inlineValue)) {
    addExactCredentialValue(values, following, budget);
  } else if (inlineValue) {
    addExactCredentialValue(values, inlineValue, budget);
  } else if (/^Bearer$/i.test(following ?? '')) {
    addExactCredentialValue(values, afterFollowing, budget);
  } else {
    addExactCredentialValue(values, following, budget);
  }
}

function configuredMcpStdioArgCredentialValues(server: ServerConfig): string[] {
  if (server.type !== 'stdio') return [];
  const values = new Set<string>();
  const budget: ExactCredentialBudget = { count: 0, totalChars: 0 };
  const args = (server.args ?? []).slice(0, MCP_ERROR_STDIO_ARG_MAX_COUNT);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const following = args[index + 1];
    const afterFollowing = args[index + 2];

    if (/^Bearer$/i.test(argument)) {
      addExactCredentialValue(values, following, budget);
    } else {
      collectHeaderCredentialValue(values, budget, argument, following, afterFollowing);
    }

    const equalsIndex = argument.indexOf('=');
    if (equalsIndex > 0) {
      const label = argument.slice(0, equalsIndex).replace(/^-+/, '');
      const value = argument.slice(equalsIndex + 1);
      if (isSensitiveStdioCredentialOptionName(label)) {
        addExactCredentialValue(values, value, budget);
      }
      if (isStdioHeaderOption(label)) {
        collectHeaderCredentialValue(values, budget, value, following, afterFollowing, true);
      }
      continue;
    }

    const optionName = argument.replace(/^-+/, '');
    if (optionName !== argument && isSensitiveStdioCredentialOptionName(optionName)) {
      addExactCredentialValue(values, following, budget);
    }
    if (optionName !== argument && isStdioHeaderOption(optionName)) {
      collectHeaderCredentialValue(
        values,
        budget,
        following,
        afterFollowing,
        args[index + 3],
        true,
      );
    }
  }
  return [...values];
}

function addConfiguredMcpCredential(
  values: Set<string>,
  raw: unknown,
  budget: ExactCredentialBudget,
): void {
  if (
    typeof raw !== 'string'
    || !raw
    || raw.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_CHARS
    || values.has(raw)
    || budget.count >= MCP_ERROR_EXACT_CREDENTIAL_MAX_VALUES
    || budget.totalChars + raw.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_TOTAL_CHARS
  ) return;
  const value = sanitizeMcpErrorControls(raw);
  if (
    !value.trim()
    || value.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_CHARS
    || values.has(value)
    || budget.count >= MCP_ERROR_EXACT_CREDENTIAL_MAX_VALUES
    || budget.totalChars + value.length > MCP_ERROR_EXACT_CREDENTIAL_MAX_TOTAL_CHARS
  ) return;
  values.add(value);
  budget.count += 1;
  budget.totalChars += value.length;
}

export function configuredMcpCredentialValues(config: Config, serverId?: string): string[] {
  const values = new Set<string>();
  const budget: ExactCredentialBudget = { count: 0, totalChars: 0 };
  const configuredServers = config.servers ?? {};
  const selected = serverId !== undefined
    && Object.prototype.hasOwnProperty.call(configuredServers, serverId)
    ? configuredServers[serverId]
    : undefined;
  const servers = (serverId !== undefined ? (selected ? [selected] : []) : Object.values(configuredServers))
    .filter((server): server is ServerConfig => Boolean(server) && typeof server === 'object')
    .slice(0, MCP_ERROR_CONFIG_SERVER_MAX_COUNT);

  // Keep transport-bound credentials ahead of lower-confidence legacy stdio
  // argument values when a malformed hand-edited config exceeds the work cap.
  for (const server of servers) {
    if (server.type === 'http') addConfiguredMcpCredential(values, server.apiKey, budget);
  }
  for (const server of servers) {
    if (server.type !== 'http') continue;
    for (const value of Object.values(server.headers ?? {}).slice(0, MCP_ERROR_CONFIG_ENTRY_MAX_COUNT)) {
      addConfiguredMcpCredential(values, value, budget);
    }
  }
  for (const server of servers) {
    if (server.type !== 'stdio') continue;
    for (const value of Object.values(server.env ?? {}).slice(0, MCP_ERROR_CONFIG_ENTRY_MAX_COUNT)) {
      addConfiguredMcpCredential(values, value, budget);
    }
  }
  for (const server of servers) {
    for (const value of configuredMcpStdioArgCredentialValues(server)) {
      addConfiguredMcpCredential(values, value, budget);
    }
  }
  // Legacy hand-edited profiles can retain fields unused by their transport.
  // They cannot displace active transport credentials, but still redact them
  // when budget remains because logout and migration errors may echo them.
  for (const server of servers) {
    if (server.type !== 'stdio') continue;
    addConfiguredMcpCredential(values, server.apiKey, budget);
    for (const value of Object.values(server.headers ?? {}).slice(0, MCP_ERROR_CONFIG_ENTRY_MAX_COUNT)) {
      addConfiguredMcpCredential(values, value, budget);
    }
  }
  for (const server of servers) {
    if (server.type !== 'http') continue;
    for (const value of Object.values(server.env ?? {}).slice(0, MCP_ERROR_CONFIG_ENTRY_MAX_COUNT)) {
      addConfiguredMcpCredential(values, value, budget);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function mcpSecretPrefixTable(secret: string): Int32Array {
  const table = new Int32Array(secret.length);
  let prefixLength = 0;
  for (let index = 1; index < secret.length; index += 1) {
    while (prefixLength > 0 && secret[index] !== secret[prefixLength]) {
      prefixLength = table[prefixLength - 1]!;
    }
    if (secret[index] === secret[prefixLength]) prefixLength += 1;
    table[index] = prefixLength;
  }
  return table;
}

function markMcpSecretMatches(
  text: string,
  secret: string,
  redactedPositions: Uint8Array,
): boolean {
  const prefixTable = mcpSecretPrefixTable(secret);
  let matched = 0;
  let intervalStart = -1;
  let intervalEnd = -1;
  let foundAny = false;

  const addInterval = (start: number, end: number): void => {
    if (intervalStart < 0) {
      intervalStart = start;
      intervalEnd = end;
      return;
    }
    if (start <= intervalEnd) {
      intervalEnd = Math.max(intervalEnd, end);
      return;
    }
    redactedPositions.fill(1, intervalStart, intervalEnd);
    foundAny = true;
    intervalStart = start;
    intervalEnd = end;
  };

  for (let index = 0; index < text.length; index += 1) {
    while (matched > 0 && text[index] !== secret[matched]) {
      matched = prefixTable[matched - 1]!;
    }
    if (text[index] === secret[matched]) matched += 1;
    if (matched === secret.length) {
      addInterval(index - secret.length + 1, index + 1);
      matched = prefixTable[matched - 1]!;
    }
  }

  // If output ends part-way through a configured value, the matched suffix is
  // still credential material. This closes truncation and transport-side
  // partial-reflection leaks without scanning beyond the fixed error window.
  if (matched > 0) addInterval(text.length - matched, text.length);
  if (intervalStart >= 0) {
    redactedPositions.fill(1, intervalStart, intervalEnd);
    foundAny = true;
  }
  return foundAny;
}

function redactExactMcpCredentials(text: string, secrets: readonly string[]): string {
  const redactedPositions = new Uint8Array(text.length);
  let foundAny = false;

  for (const secret of secrets) {
    if (secret && markMcpSecretMatches(text, secret, redactedPositions)) foundAny = true;
  }
  if (!foundAny) return text;

  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const masked = redactedPositions[cursor] === 1;
    let end = cursor + 1;
    while (end < text.length && (redactedPositions[end] === 1) === masked) end += 1;
    parts.push(masked ? '[redacted]' : text.slice(cursor, end));
    cursor = end;
  }
  return parts.join('');
}

/** Scrub a transport error using generic patterns plus the profile's exact saved secrets. */
export function redactMcpErrorText(text: string, config: Config, serverId?: string): string {
  const inputWasTruncated = text.length > MCP_ERROR_TEXT_MAX_CHARS;
  const exactWindow = sanitizeMcpErrorControls(inputWasTruncated
    ? text.slice(0, MCP_ERROR_TEXT_MAX_CHARS - MCP_ERROR_TRUNCATION_MARKER.length)
    : text);
  const secrets = configuredMcpCredentialValues(config, serverId);
  let redacted = redactExactMcpCredentials(
    exactWindow,
    secrets,
  );
  redacted = sanitizeMcpErrorControls(decodeUrlComponentTolerantly(redacted));
  redacted = redactExactMcpCredentials(redacted, secrets);
  if (inputWasTruncated) redacted += MCP_ERROR_TRUNCATION_MARKER;
  return redactMcpHttpUrlsInText(redacted);
}

/** Safe argument rendering for legacy stdio profiles with inline secrets. */
export function redactMcpStdioArgs(args: readonly string[]): string[] {
  let redactNext = false;
  let redactBearerValue = false;
  let redactHeaderValue = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return '[redacted]';
    }
    if (redactBearerValue) {
      redactBearerValue = false;
      return '[redacted]';
    }
    if (redactHeaderValue) {
      redactHeaderValue = false;
      if (/^Bearer$/i.test(argument)) {
        redactBearerValue = true;
        return argument;
      }
      return '[redacted]';
    }
    if (/^https?:\/\//i.test(argument)) return redactMcpHttpUrl(argument);

    const equalsIndex = argument.indexOf('=');
    if (equalsIndex > 0) {
      const label = argument.slice(0, equalsIndex).replace(/^-+/, '');
      const value = argument.slice(equalsIndex + 1);
      if (isSensitiveStdioCredentialOptionName(label)) {
        return `${argument.slice(0, equalsIndex + 1)}[redacted]`;
      }
      if (/^https?:\/\//i.test(value)) {
        return `${argument.slice(0, equalsIndex + 1)}${redactMcpHttpUrl(value)}`;
      }
      if (/^(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|credential|signature|cookie)\s*:\s*Bearer\s*$/i.test(value)) {
        redactBearerValue = true;
        return argument;
      }
      if (containsObviousCredentialValue(value)) {
        return `${argument.slice(0, equalsIndex + 1)}[redacted]`;
      }
      if (/^(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|credential|signature|cookie)\s*:\s*$/i.test(value)) {
        redactHeaderValue = true;
      }
    }

    const optionName = argument.replace(/^-+/, '');
    if (optionName !== argument && isSensitiveStdioCredentialOptionName(optionName)) {
      redactNext = true;
      return argument;
    }
    if (/^Bearer$/i.test(argument)) {
      redactBearerValue = true;
      return argument;
    }
    if (/^(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|credential|signature|cookie)\s*:\s*Bearer\s*$/i.test(argument)) {
      redactBearerValue = true;
      return argument;
    }
    if (/^(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|credential|signature|cookie)\s*:\s*$/i.test(argument)) {
      redactHeaderValue = true;
      return argument;
    }
    return containsObviousCredentialValue(argument) || /\bBearer\s+\S+/i.test(argument)
      ? '[redacted]'
      : redactMcpHttpUrlsInText(argument);
  });
}

function headerCredentialTrailingArgs(
  expression: string | undefined,
  following?: string,
  afterFollowing?: string,
  allowUndelimitedName = false,
): number | undefined {
  const trimmed = expression?.trim();
  if (!trimmed) return undefined;
  const match = /^([^:=]+)\s*[:=]\s*(.*)$/s.exec(trimmed);
  const name = match?.[1]?.trim() ?? (allowUndelimitedName ? trimmed : '');
  if (!name || !isSensitiveCredentialName(name)) return undefined;

  const inlineValue = match?.[2]?.trim() ?? '';
  if (/^Bearer$/i.test(inlineValue)) return following === undefined ? 0 : 1;
  if (inlineValue) return 0;
  if (/^Bearer$/i.test(following ?? '')) {
    return afterFollowing === undefined ? (following === undefined ? 0 : 1) : 2;
  }
  return following === undefined ? 0 : 1;
}

function mcpHttpUrlContainsCredentials(raw: string | undefined): boolean {
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || hasSensitivePathMaterial(parsed.pathname)) return true;
    for (const [key, value] of parsed.searchParams) {
      if (isSensitiveCredentialName(key) || containsInlineCredentialMaterial(value)) return true;
    }
    return false;
  } catch {
    return containsInlineCredentialMaterial(raw);
  }
}

function containsInlineCredentialMaterial(value: string): boolean {
  return /^Bearer\s+\S+/i.test(value.trim()) || containsObviousCredentialValue(value);
}

/**
 * Remove credential-bearing stdio arguments while preserving transport and
 * file-location arguments. Legacy profiles sometimes embedded auth in command
 * arguments; logout must make those profiles inert without deleting safe
 * `--token-file`, `--private-key-path`, `--root`, or certificate paths.
 */
export function stripMcpStdioCredentials(args: readonly string[]): string[] {
  const kept: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const following = args[index + 1];
    const afterFollowing = args[index + 2];
    const equalsIndex = argument.indexOf('=');

    if (equalsIndex > 0) {
      const rawLabel = argument.slice(0, equalsIndex);
      const label = rawLabel.replace(/^-+/, '');
      const value = argument.slice(equalsIndex + 1);
      if (isSensitiveStdioCredentialOptionName(label)) {
        if (/^Bearer$/i.test(value.trim()) && following !== undefined) index += 1;
        continue;
      }
      if (isStdioHeaderOption(label)) {
        const trailing = headerCredentialTrailingArgs(value, following, afterFollowing, true);
        if (trailing !== undefined) {
          index += trailing;
          continue;
        }
      }
      if (isStdioEnvOption(label)) {
        const trailing = headerCredentialTrailingArgs(value, following, afterFollowing, true);
        if (trailing !== undefined) {
          index += trailing;
          continue;
        }
      }
      if (mcpHttpUrlContainsCredentials(value) || containsInlineCredentialMaterial(value)) continue;
    }

    const optionName = argument.replace(/^-+/, '');
    if (optionName !== argument && isSensitiveStdioCredentialOptionName(optionName)) {
      if (following !== undefined) {
        index += /^Bearer$/i.test(following) && afterFollowing !== undefined ? 2 : 1;
      }
      continue;
    }
    if (optionName !== argument && isStdioHeaderOption(optionName)) {
      const trailing = headerCredentialTrailingArgs(
        following,
        afterFollowing,
        args[index + 3],
        true,
      );
      if (trailing !== undefined) {
        index += 1 + trailing;
        continue;
      }
    }
    if (optionName !== argument && isStdioEnvOption(optionName)) {
      const trailing = headerCredentialTrailingArgs(
        following,
        afterFollowing,
        args[index + 3],
        true,
      );
      if (trailing !== undefined) {
        index += 1 + trailing;
        continue;
      }
    }

    const rawHeaderTrailing = headerCredentialTrailingArgs(argument, following, afterFollowing);
    if (rawHeaderTrailing !== undefined) {
      index += rawHeaderTrailing;
      continue;
    }
    if (/^Bearer$/i.test(argument)) {
      if (following !== undefined) index += 1;
      continue;
    }
    if (mcpHttpUrlContainsCredentials(argument) || containsInlineCredentialMaterial(argument)) continue;
    if (
      optionName !== argument
      && (mcpHttpUrlContainsCredentials(following) || containsInlineCredentialMaterial(following ?? ''))
    ) {
      index += 1;
      continue;
    }
    kept.push(argument);
  }

  return kept;
}

/** Safe terminal/UI rendering for legacy stdio profiles with inline secrets. */
export function redactMcpStdioCommand(
  server: Pick<ServerConfig, 'command' | 'args'>,
): string {
  const args = redactMcpStdioArgs(server.args ?? []);
  return redactMcpHttpUrlsInText(
    [server.command ?? '', ...args].filter(Boolean).join(' '),
  );
}

/** Never prefill a prompt with credential-bearing legacy stdio arguments. */
export function editableMcpStdioCommand(
  server: Pick<ServerConfig, 'command' | 'args'>,
): string {
  const raw = [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ');
  return raw === redactMcpStdioCommand(server) ? raw : '';
}

/** Never prefill a prompt with credential-bearing legacy URL material. */
export function editableMcpHttpUrl(raw: string | undefined): string {
  if (!raw || validateMcpHttpUrl(raw)) return '';
  return normalizeMcpHttpUrl(raw);
}
