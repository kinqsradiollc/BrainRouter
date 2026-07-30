import { createHash } from 'node:crypto';
import path from 'node:path';

const BROWSER_PARTITION_BASE = 'persist:brainrouter-browser';
const FALLBACK_BROWSER_LOCALE = 'en-US';

/** Keep Chromium's navigation headers and JavaScript locale in one ordinary,
 * deterministic order. Invalid host locale values fail back to English rather
 * than emitting malformed request metadata. */
export function browserAcceptLanguages(locale: string): string {
  const normalized = locale.trim().replace(/_/g, '-');
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(normalized)) {
    return `${FALLBACK_BROWSER_LOCALE},en`;
  }
  const parts = normalized.split('-');
  const canonical = [
    parts[0].toLowerCase(),
    ...parts.slice(1).map((part) => part.length === 2
      ? part.toUpperCase()
      : part),
  ].join('-');
  const base = parts[0].toLowerCase();
  return canonical.toLowerCase() === base ? canonical : `${canonical},${base}`;
}

/** A standard desktop Chromium User-Agent for the bundled engine. It omits
 * application product tokens while preserving Chromium's normal platform
 * shape. */
export function standardChromeUserAgent(
  chromeVersion = process.versions.chrome || '120.0.0.0',
  platform = process.platform,
): string {
  const platformToken = platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/**
 * Use one durable browser profile per workspace. Chat sessions share the
 * workspace's cookies, storage, cache, and login/challenge continuity while
 * different workspaces remain isolated.
 */
export function browserPartitionForWorkspace(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot || '.');
  const key = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `${BROWSER_PARTITION_BASE}-${key}`;
}
