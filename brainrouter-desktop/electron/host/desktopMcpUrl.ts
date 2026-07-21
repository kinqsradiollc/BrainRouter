/**
 * Validate and classify renderer-supplied MCP HTTP endpoints.
 *
 * Loopback and private-network hosts are intentionally supported: these URLs
 * are explicit user configuration for local and self-hosted MCP servers. The
 * security boundary here is the URL shape and credential placement, not the
 * destination network.
 */
const DESKTOP_MCP_SENSITIVE_NAME_PARTS = [
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
const DESKTOP_MCP_URL_MAX_BYTES = 16 * 1024;
const DESKTOP_MCP_MAX_PERCENT_DECODE_PASSES = 8;

export function decodeDesktopMcpUrlComponentTolerantly(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < DESKTOP_MCP_MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const next = decoded.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) =>
      Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8'));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function normalizeDesktopMcpCredentialName(name: string): string {
  return decodeDesktopMcpUrlComponentTolerantly(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function isDesktopMcpSensitiveCredentialName(name: string): boolean {
  const normalized = normalizeDesktopMcpCredentialName(name);
  return normalized === 'key'
    || normalized === 'sig'
    || normalized === 'auth'
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('connectionstring')
    || normalized.endsWith('databaseurl')
    || normalized.endsWith('signature')
    || DESKTOP_MCP_SENSITIVE_NAME_PARTS.some((part) => normalized === part || normalized.endsWith(part));
}

export function containsDesktopMcpObviousCredentialValue(value: string): boolean {
  const decoded = decodeDesktopMcpUrlComponentTolerantly(value);
  return /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-[^/]{8,}|AKIA[A-Z0-9]{16})/i.test(decoded)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|password|signature|token|secret)\s*[:=]\s*\S+/i.test(decoded)
    || /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(decoded)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(decoded);
}

export function isDesktopMcpCredentialPathLabel(segment: string): boolean {
  const normalized = normalizeDesktopMcpCredentialName(segment);
  return normalized === 'key'
    || normalized === 'auth'
    || normalized === 'sig'
    || DESKTOP_MCP_SENSITIVE_NAME_PARTS.some((part) => normalized === part);
}

export function hasDesktopMcpSensitivePathMaterial(pathname: string): boolean {
  // Decode before splitting so encoded separators cannot hide a token/value path.
  const segments = decodeDesktopMcpUrlComponentTolerantly(pathname).split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (containsDesktopMcpObviousCredentialValue(segment)) return true;
    if (index > 0 && isDesktopMcpCredentialPathLabel(segments[index - 1]!) && segment) return true;
  }
  return false;
}

/** Validate an MCP HTTP endpoint before it crosses the desktop persistence boundary. */
export function validateDesktopMcpHttpUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return 'MCP URL is required.';
  if (Buffer.byteLength(value) > DESKTOP_MCP_URL_MAX_BYTES) return 'MCP URL is too long.';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'MCP URL is invalid.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'MCP URL must use http or https.';
  }
  if (parsed.username || parsed.password) {
    return 'Put credentials in the API key or headers field, not the URL.';
  }
  if (hasDesktopMcpSensitivePathMaterial(parsed.pathname)) {
    return 'The MCP URL path appears to contain credentials. Use the API key or headers field.';
  }
  for (const [name, queryValue] of parsed.searchParams) {
    if (isDesktopMcpSensitiveCredentialName(name)) {
      return 'The MCP URL query appears to contain credentials. Use the API key or headers field.';
    }
    if (containsDesktopMcpObviousCredentialValue(queryValue)) {
      return 'The MCP URL query value appears to contain credentials. Use the API key or headers field.';
    }
  }
  if (parsed.hash) return 'MCP URL fragments are not supported.';
  return undefined;
}
