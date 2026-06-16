/**
 * SEC — top-level navigation policy for a BrowserWindow. A compromised or
 * malicious renderer must not be able to navigate the window away from the
 * app's own content (phishing, token theft, `data:`/`javascript:` payloads).
 *
 * Allowed: the packaged `file://` load, and — only in dev — the Vite dev
 * origin. Everything else is denied. Pure + unit-tested; main.ts wires it into
 * `will-navigate` (and pairs it with a deny-all `setWindowOpenHandler`).
 */
export function isAllowedNavigation(url: string, allowedOrigin: string | null): boolean {
  try {
    const target = new URL(url);
    if (target.protocol === 'file:') return true; // the app's own packaged load
    if (allowedOrigin && target.origin === allowedOrigin) return true; // dev server
  } catch {
    return false; // malformed URL → deny
  }
  return false;
}

/** The origin the renderer is allowed to navigate within, derived from the dev
 *  server URL when present (dev) or null (packaged → only file:// is allowed). */
export function allowedOriginFor(devServerUrl: string | undefined): string | null {
  if (!devServerUrl) return null;
  try {
    return new URL(devServerUrl).origin;
  } catch {
    return null;
  }
}
