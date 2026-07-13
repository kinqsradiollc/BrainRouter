/**
 * §3 D3 — sandboxed-webview security policy (the `will-attach-webview` core).
 *
 * Enabling `<webview>` is a privilege; this module is the pure gate that makes it
 * safe, kept here so it's unit-testable away from the electron main process.
 * Every attached webview is HARDENED (no preload, no node, sandboxed, context-
 * isolated, webSecurity on). The Browser panel is a general-purpose web browser,
 * so ANY http(s) origin is navigable — the sandboxed guest, not an origin
 * allowlist, is the security boundary. `file://` stays restricted to authorized
 * prototype files INSIDE the workspace (no arbitrary local-file read), only
 * self-contained `data:text/html` is allowed, and every other scheme
 * (javascript:, other data: types, file traversal) is refused.
 */

import path from 'node:path';
import { isAuthorizedPrototypePath } from '@kinqs/brainrouter-core/prototype';

/** Mutate a webview's webPreferences into the locked-down shape (defence in depth). */
export function hardenWebviewPreferences(prefs: Record<string, unknown>): void {
  delete prefs.preload;
  delete prefs.preloadURL;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.experimentalFeatures = false;
}

/** Any http(s) origin. The Browser panel is a general web browser; the hardened
 * sandbox (no node, contextIsolation, sandbox, webSecurity) is what keeps a
 * remote page from touching the app or the host. */
export function isHttpSrc(src: string): boolean {
  let url: URL;
  try { url = new URL(src); } catch { return false; }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Link-local / cloud-metadata literals (IPv4 169.254.0.0/16 incl. the
 * 169.254.169.254 metadata endpoint; IPv6 fe80::/10 + the fd00:ec2::254 EC2
 * literal). These are the classic SSRF credential-theft target and have no
 * legitimate browsing use, so they're refused even in general-browsing mode.
 * (Public, loopback, and normal LAN hosts stay reachable — this is a real
 * browser, not a locked-down viewer.) A hostname that DNS-resolves to a
 * metadata IP is a residual gap a sync gate can't close.
 */
export function isMetadataOrLinkLocalHost(src: string): boolean {
  let url: URL;
  try { url = new URL(src); } catch { return false; }
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.startsWith('fe80:') || h === 'fd00:ec2::254') return true;
  return false;
}

/** A loopback dev-server origin — a subset of {@link isHttpSrc}, kept for callers
 * that specifically want the "workspace's own dev server" narrowing. */
export function isLoopbackHttpSrc(src: string): boolean {
  let url: URL;
  try { url = new URL(src); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Whether a webview may load `src`. Allowed: ANY http(s) URL (general browsing);
 * a self-contained `data:text/html` document; or a `file://` URL that resolves
 * INSIDE `workspaceRoot` and is an authorized prototype path. Everything else
 * (javascript:, other data: types, files outside the workspace, traversal) is
 * refused. The hardened, sandboxed guest — not an origin allowlist — is the
 * boundary that makes remote browsing safe.
 */
export function isAllowedWebviewSrc(src: string, workspaceRoot: string): boolean {
  if (typeof src !== 'string' || !src) return false;
  if (src.startsWith('data:text/html')) return true;
  if (isHttpSrc(src)) return !isMetadataOrLinkLocalHost(src);
  if (src.startsWith('file://')) {
    let filePath: string;
    try { filePath = decodeURIComponent(new URL(src).pathname); } catch { return false; }
    if (!filePath) return false;
    const rel = path.relative(workspaceRoot, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return isAuthorizedPrototypePath(rel);
  }
  return false;
}
