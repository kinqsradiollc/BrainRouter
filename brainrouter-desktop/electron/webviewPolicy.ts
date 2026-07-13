/**
 * §3 D3 — sandboxed-webview security policy (the `will-attach-webview` core).
 *
 * Enabling `<webview>` is a privilege; this module is the pure gate that makes it
 * safe, kept here so it's unit-testable away from the electron main process.
 * Every attached webview is HARDENED (no preload, no node, sandboxed, context-
 * isolated) and its `src` is restricted to either a self-contained `data:text/html`
 * document or an AUTHORIZED prototype file under the workspace's `proto/` dir
 * (reusing the tested `isAuthorizedPrototypePath`). Anything else is refused.
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

/**
 * A loopback dev-server origin — `http(s)://localhost|127.0.0.1|[::1]:<port>`.
 * The Browser (UI-testing) panel points a hardened webview at the workspace's
 * OWN running dev server, which is always loopback. Restricting to loopback
 * hostnames keeps the relaxation bounded: no remote origin is ever reachable.
 */
export function isLoopbackHttpSrc(src: string): boolean {
  let url: URL;
  try { url = new URL(src); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Whether a webview may load `src`. Allowed: a self-contained `data:text/html`
 * document (no network reachable once we inject the blocking CSP); a `file://`
 * URL that resolves INSIDE `workspaceRoot` and is an authorized prototype path;
 * or a LOOPBACK http(s) dev-server URL for the Browser panel. Everything else
 * (remote http(s):, other data: types, files outside the workspace, traversal)
 * is refused.
 */
export function isAllowedWebviewSrc(src: string, workspaceRoot: string): boolean {
  if (typeof src !== 'string' || !src) return false;
  if (src.startsWith('data:text/html')) return true;
  if (isLoopbackHttpSrc(src)) return true;
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
