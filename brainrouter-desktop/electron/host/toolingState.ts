/**
 * ADR-028 I1/I3 — the small amount of state provisioning and identity need.
 *
 * Two files under the brainrouter home: which offers were declined, and which
 * account each workspace pushes as.
 *
 * Deliberately NOT a credential store. The binding records a LOGIN NAME so it
 * can be compared against whatever `gh` reports; it holds no token and can
 * grant nothing. A second credential store would drift from the one git and gh
 * actually use, and drift you trust is worse than no guard.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceBinding } from '@kinqs/brainrouter-core/tooling';

function homeDir(): string {
  const base = process.env.BRAINROUTER_HOME ?? path.join(os.homedir(), '.brainrouter');
  mkdirSync(base, { recursive: true });
  return base;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(homeDir(), file), 'utf8')) as T;
  } catch {
    // A missing or corrupt file means "nothing declined, nothing bound", which
    // is the safe reading: it offers again and asks before the first push.
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(path.join(homeDir(), file), JSON.stringify(value, null, 2));
}

export function readDeclinedTools(): Set<string> {
  return new Set(readJson<string[]>('declined-tools.json', []));
}

export function writeDeclinedTool(id: string): void {
  if (!id) return;
  const all = readDeclinedTools();
  all.add(id);
  writeJson('declined-tools.json', [...all]);
}

export function readWorkspaceBinding(workspaceRoot: string): WorkspaceBinding | null {
  const all = readJson<Record<string, WorkspaceBinding>>('git-bindings.json', {});
  return all[workspaceRoot] ?? null;
}

export function writeWorkspaceBinding(binding: WorkspaceBinding): void {
  const all = readJson<Record<string, WorkspaceBinding>>('git-bindings.json', {});
  all[binding.workspaceRoot] = binding;
  writeJson('git-bindings.json', all);
}
