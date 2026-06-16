import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from './cliState.js';

/**
 * T1 — trusted workspaces: folders the user has explicitly allowed BrainRouter
 * to operate in (run hooks / workspace agent-instructions / shell). Persisted
 * GLOBALLY at `~/.brainrouter/trusted-workspaces.json` so the CLI and the
 * desktop agree on the same trust set — this replaces the desktop's old
 * renderer-only `localStorage` list, which neither persisted across reinstalls
 * nor was visible to the CLI / main process.
 */
function trustFile(): string {
  return path.join(getBrainrouterHome(), 'trusted-workspaces.json');
}

function norm(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

function readAll(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(trustFile(), 'utf-8')) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function write(list: string[]): void {
  try {
    fs.mkdirSync(getBrainrouterHome(), { recursive: true });
    fs.writeFileSync(trustFile(), JSON.stringify(list, null, 2));
  } catch { /* best-effort; trust simply won't persist if the home is unwritable */ }
}

/** Is `root` (path-normalized) on the trusted list? */
export function isWorkspaceTrusted(root: string): boolean {
  const n = norm(root);
  return readAll().some((r) => norm(r) === n);
}

/** All trusted workspace roots, most-recently-trusted first (for a manage UI). */
export function listTrustedWorkspaces(): string[] {
  return readAll();
}

/** Mark `root` trusted (idempotent; moves it to the front). */
export function trustWorkspace(root: string): void {
  const n = norm(root);
  write([n, ...readAll().filter((r) => norm(r) !== n)]);
}

/** Remove `root` from the trusted list. */
export function untrustWorkspace(root: string): void {
  const n = norm(root);
  write(readAll().filter((r) => norm(r) !== n));
}
