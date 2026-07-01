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
 * Whether a webview may load `src`. Allowed: a self-contained `data:text/html`
 * document (no network reachable once we inject the blocking CSP), or a
 * `file://` URL that resolves INSIDE `workspaceRoot` and is an authorized
 * prototype path. Everything else (http(s):, other data: types, files outside
 * the workspace, traversal) is refused.
 */
export function isAllowedWebviewSrc(src: string, workspaceRoot: string): boolean {
  if (typeof src !== 'string' || !src) return false;
  if (src.startsWith('data:text/html')) return true;
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
