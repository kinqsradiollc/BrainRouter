const DEV_MCP_URL_MAX_BYTES = 16 * 1024;
const DEV_MCP_PERCENT_DECODE_PASSES = 8;
const DEV_MCP_SENSITIVE_NAMES = [
  'apikey',
  'accesskey',
  'privatekey',
  'accesstoken',
  'refreshtoken',
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

export type DevMcpUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

function decodeUrlText(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < DEV_MCP_PERCENT_DECODE_PASSES; pass += 1) {
    const next = decoded.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) => {
      const bytes = encoded.slice(1).split('%').map((value) => Number.parseInt(value, 16));
      return new TextDecoder().decode(Uint8Array.from(bytes));
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function normalizeCredentialName(value: string): string {
  return decodeUrlText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveName(value: string): boolean {
  const normalized = normalizeCredentialName(value);
  return normalized === 'key'
    || normalized === 'sig'
    || normalized === 'auth'
    || DEV_MCP_SENSITIVE_NAMES.some((name) => normalized === name || normalized.endsWith(name));
}

function containsObviousCredential(value: string): boolean {
  const decoded = decodeUrlText(value);
  return /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-[^/]{8,}|AKIA[A-Z0-9]{16})/i.test(decoded)
    || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|password|signature|token|secret)\s*[:=]\s*\S+/i.test(decoded)
    || /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(decoded);
}

function hasSensitivePath(pathname: string): boolean {
  const segments = decodeUrlText(pathname).split('/');
  return segments.some((segment, index) =>
    containsObviousCredential(segment)
    || (index > 0 && isSensitiveName(segments[index - 1]!) && Boolean(segment)));
}

/** Keep the browser-only development bridge aligned with the production host boundary. */
export function validateDevMcpHttpUrl(raw: unknown): DevMcpUrlResult {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error: 'An HTTP server needs a URL.' };
  if (new TextEncoder().encode(value).byteLength > DEV_MCP_URL_MAX_BYTES) {
    return { ok: false, error: 'MCP URL is too long.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'MCP URL is invalid.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'MCP URL must use http or https.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Put credentials in the API key or headers field, not the URL.' };
  }
  if (parsed.hash) return { ok: false, error: 'MCP URL fragments are not supported.' };
  if (hasSensitivePath(parsed.pathname)) {
    return { ok: false, error: 'The MCP URL path appears to contain credentials.' };
  }
  for (const [name, queryValue] of parsed.searchParams) {
    if (isSensitiveName(name) || containsObviousCredential(queryValue)) {
      return { ok: false, error: 'The MCP URL query appears to contain credentials.' };
    }
  }
  return { ok: true, url: parsed.toString() };
}
