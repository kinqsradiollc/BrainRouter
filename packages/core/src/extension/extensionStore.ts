/**
 * EXTENSION-STORE (0.4.15) — per-user enable/disable state for extensions,
 * stored at `~/.brainrouter/extensions.json` (in the global home).
 * Default is ENABLED: an extension is active unless explicitly disabled here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../storage/store.js';

interface ExtensionStateFile {
  /** Names explicitly DISABLED by the user (absence = enabled). */
  disabled: string[];
}

function storePath(): string {
  return path.join(getBrainrouterHome(), 'extensions.json');
}

function read(): ExtensionStateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf-8')) as Partial<ExtensionStateFile>;
    return { disabled: Array.isArray(raw.disabled) ? raw.disabled : [] };
  } catch {
    return { disabled: [] };
  }
}

function write(file: ExtensionStateFile): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf-8');
}

export function isExtensionEnabled(name: string): boolean {
  return !read().disabled.includes(name);
}

export function setExtensionEnabled(name: string, enabled: boolean): void {
  const file = read();
  const has = file.disabled.includes(name);
  if (enabled && has) file.disabled = file.disabled.filter((n) => n !== name);
  else if (!enabled && !has) file.disabled.push(name);
  else return;
  write(file);
}
