/**
 * INTERACTIVE PROTOTYPE GENERATION (§3 D2) — pure helpers for the async,
 * incrementally-written HTML prototype flow.
 *
 * The agent reserves a path, then writes the prototype incrementally (a skeleton
 * `write` then several `edit`s). The desktop polls that path and renders it once
 * it's "done". Because writes are incremental, "done" is closing `</html>` AND
 * byte-stability across two consecutive polls — never just the presence of the
 * tag. While generation is pending, an async-placeholder token marks the insert
 * position so the editor can swap in the result when it lands (even after the
 * doc was closed). All pure → unit-tested; the desktop poll loop + sandboxed
 * `<webview>` (D3) consume these.
 */

/**
 * A prototype HTML file is "done" when it closes `</html>` AND is byte-stable
 * across two consecutive polls. Returns false on the first poll (no previous to
 * compare) so we never render a half-written file.
 */
export function isPrototypeComplete(previous: string | null, current: string): boolean {
  if (!current || !current.includes('</html>')) return false;
  return previous !== null && current === previous;
}

/** Reserved on-disk path for a generated prototype, under a `proto/` segment. */
export function reservePrototypePath(timestamp: number, hex: string): string {
  const safeHex = hex.replace(/[^a-f0-9]/gi, '').slice(0, 8) || '00000000';
  return `proto/prototype-${timestamp}-${safeHex}.html`;
}

/**
 * Pure pre-checks for the D3 sandboxed-webview authorization gate: a prototype
 * path must be an `.html`/`.htm` file inside a `proto/` segment with no traversal
 * or absolute/NUL escapes. The host additionally canonicalizes symlinks and
 * confirms the resolved path is inside the workspace before authorizing the
 * webview `src` — this is the cheap, deterministic first line of defence.
 */
export function isAuthorizedPrototypePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (!/\.html?$/i.test(relPath)) return false;
  if (relPath.startsWith('/') || relPath.includes('..') || relPath.includes('\0')) return false;
  return relPath.split('/').includes('proto');
}

const SCHEME = 'br-pending-gen://';

/** Async-placeholder token carrying a pending-generation id. */
export function makePlaceholderToken(id: string): string {
  return `${SCHEME}${id}`;
}

const TOKEN_RE = /br-pending-gen:\/\/([A-Za-z0-9_-]+)/g;

/** Every pending-generation id referenced in a document, de-duplicated. */
export function findPlaceholderTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** Replace every occurrence of one placeholder token with the resolved content. */
export function resolvePlaceholder(text: string, id: string, replacement: string): string {
  return text.split(makePlaceholderToken(id)).join(replacement);
}
