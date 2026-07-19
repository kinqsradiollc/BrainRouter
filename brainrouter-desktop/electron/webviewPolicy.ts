/**
 * Sandboxed remote-page and artifact-preview security policy.
 *
 * The first-class Browser uses main-owned WebContentsViews; the Artifact preview
 * retains one tightly gated renderer webview. Remote pages and that preview share
 * the pure URL policy below, while every attached artifact webview is hardened
 * (no preload, no node, sandboxed, context-isolated, webSecurity on). The Browser
 * accepts normal http(s) origins; its sandbox is the page/host boundary. `file://`
 * stays restricted to authorized
 * prototype files INSIDE the workspace (no arbitrary local-file read), only
 * self-contained `data:text/html` is allowed, and every other scheme
 * (javascript:, other data: types, file traversal) is refused.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  return isMetadataOrLinkLocalAddress(url.hostname);
}

/** Block resolved destinations that can expose cloud-instance credentials. */
export function isMetadataOrLinkLocalAddress(address: string): boolean {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (normalized === 'fd00:ec2::254') return true;
  const first = normalized.split(':', 1)[0];
  return /^fe[89ab][0-9a-f]$/.test(first);
}

/** Addresses an agent must not discover or probe merely by navigating. Normal
 * user browsing still supports local dev servers and LAN devices. */
export function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  const octets = normalized.split('.').map(Number);
  if (octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    const [a, b] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (normalized === '::' || normalized === '::1') return true;
  const first = normalized.split(':', 1)[0];
  return /^f[cd][0-9a-f]{2}$/.test(first) || /^fe[89ab][0-9a-f]$/.test(first);
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

/** Legacy artifact/prototype preview gate. The first-class browser uses
 * WebContentsView; renderer-owned webviews remain limited to isolated local
 * prototypes and self-contained HTML and can never become a second browser. */
export function isAllowedArtifactWebviewSrc(src: string, workspaceRoot: string): boolean {
  if (typeof src !== 'string' || (!src.startsWith('data:text/html') && !src.startsWith('file://'))) return false;
  if (src.startsWith('data:text/html')) return true;
  try {
    const root = fs.realpathSync(workspaceRoot);
    const target = fs.realpathSync(fileURLToPath(src));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) return false;
    const relative = path.relative(root, target);
    return !relative.startsWith('..')
      && !path.isAbsolute(relative)
      && fs.statSync(target).isFile()
      && isAuthorizedPrototypePath(relative);
  } catch {
    return false;
  }
}
