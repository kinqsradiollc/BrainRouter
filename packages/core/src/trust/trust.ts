/**
 * PROJECT-TRUST (0.4.15) — a per-USER gate on executing in-workspace code.
 *
 * BrainRouter agents run unattended in arbitrary checked-out repos. Any feature
 * that runs code FROM the workspace (the typed extension API, pack hooks) is
 * arbitrary code execution from a clone. This module is the gate: a workspace
 * must be explicitly trusted before such code is activated.
 *
 * The trust list lives PER-USER at `~/.config/brainrouter/trust.json` (honoring
 * `BRAINROUTER_HOME` like the rest of the home-rooted state) — never inside the
 * workspace, so a repo cannot trust itself. Pure fs; no caching (cheap + always
 * fresh, mirroring the rest of the JSON stores).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfigHome } from '../storage/store.js';

export interface TrustEntry {
  /** Canonicalized workspace root (resolved, no trailing slash). */
  workspaceRoot: string;
  trustedAt: string;
  trustedBy?: string;
}

interface TrustFile {
  trusted: TrustEntry[];
}

/** Per-user trust list path (under the shared config home). */
export function trustFilePath(): string {
  return path.join(getConfigHome(), 'trust.json');
}

/** Canonicalize a workspace root so the same dir matches regardless of symlinks
 *  or a trailing slash (realpath when it exists, else a normalized resolve). */
export function canonicalWorkspace(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved.replace(/[/\\]+$/, '');
  }
}

function readTrust(): TrustFile {
  try {
    const raw = JSON.parse(fs.readFileSync(trustFilePath(), 'utf-8')) as Partial<TrustFile>;
    return { trusted: Array.isArray(raw.trusted) ? raw.trusted : [] };
  } catch {
    return { trusted: [] };
  }
}

function writeTrust(file: TrustFile): void {
  const p = trustFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf-8');
}

/** True iff the workspace has been explicitly trusted by this user. */
export function isWorkspaceTrusted(workspaceRoot: string): boolean {
  const canon = canonicalWorkspace(workspaceRoot);
  return readTrust().trusted.some((t) => t.workspaceRoot === canon);
}

/** Mark a workspace trusted (idempotent — re-trusting refreshes the timestamp). */
export function trustWorkspace(workspaceRoot: string, trustedBy?: string): TrustEntry {
  const canon = canonicalWorkspace(workspaceRoot);
  const file = readTrust();
  const entry: TrustEntry = { workspaceRoot: canon, trustedAt: new Date().toISOString(), ...(trustedBy ? { trustedBy } : {}) };
  file.trusted = file.trusted.filter((t) => t.workspaceRoot !== canon);
  file.trusted.push(entry);
  writeTrust(file);
  return entry;
}

/** Revoke trust. Returns true iff a matching entry was removed. */
export function revokeWorkspace(workspaceRoot: string): boolean {
  const canon = canonicalWorkspace(workspaceRoot);
  const file = readTrust();
  const next = file.trusted.filter((t) => t.workspaceRoot !== canon);
  if (next.length === file.trusted.length) return false;
  writeTrust({ trusted: next });
  return true;
}

/** All trusted workspaces (for `/trust` listing). */
export function listTrusted(): TrustEntry[] {
  return readTrust().trusted;
}
