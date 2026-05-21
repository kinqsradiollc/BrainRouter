// ─────────────────────────────────────────────
// BrainRouter MCP Server — Root Resolver
// Determines globalRoot and localRoot at startup.
// ─────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join, basename, isAbsolute, win32, posix } from 'path';
import { fileURLToPath } from 'url';
import type { RegistryConfig, BrainRouterConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find the repo root by looking for key markers: skills/, docs/, or package.json
function findRepoRoot(start: string): string {
  let current = start;
  while (current !== resolve('/')) {
    // 1. Installed-package mode: when this MCP package was published with bundled
    //    skills/ (via scripts/prepack.mjs), the package directory itself is the
    //    global root. Detect that by the presence of both package.json AND skills/.
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'skills'))) {
      return current;
    }

    // 2. Monorepo mode: a parent directory that contains skills/ or docs/ but
    //    where the current "mcp" subfolder is the package install.
    if (
      existsSync(join(current, 'skills')) ||
      existsSync(join(current, 'docs')) ||
      existsSync(join(current, 'package.json'))
    ) {
      if (basename(current) === 'mcp') {
        return dirname(current);
      }
      return current;
    }
    current = dirname(current);
  }
  // Fallback to two levels up from dist/ (where this file usually lives)
  return resolve(__dirname, '../../');
}

const GLOBAL_ROOT = findRepoRoot(__dirname);

export function isForeignAbsolutePath(workspacePath: string | undefined): boolean {
  const candidate = workspacePath?.trim();
  if (!candidate) return false;

  const absoluteOnSomePlatform = win32.isAbsolute(candidate) || posix.isAbsolute(candidate);
  return absoluteOnSomePlatform && !isAbsolute(candidate);
}

function fallbackWorkspacePath(workspacePath: string): string {
  const workspaceHash = createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
  return join(homedir(), '.brainrouter', 'fallback-workspaces', workspaceHash);
}

export function getSafeWorkspacePath(workspacePath: string): string {
  if (isForeignAbsolutePath(workspacePath)) {
    return fallbackWorkspacePath(workspacePath);
  }

  return resolve(workspacePath);
}

/**
 * Parse --root <path> from process.argv.
 */
function parseRootFlag(): string | undefined {
  const idx = process.argv.indexOf('--root');
  if (idx !== -1 && process.argv[idx + 1]) {
    return resolve(process.argv[idx + 1]);
  }
  return undefined;
}

/**
 * Walk up from startDir looking for brainrouter.config.json or AGENT.md.
 * Returns the directory where it was found, or undefined.
 */
function autoDetectLocalRoot(startDir: string): string | undefined {
  let current = startDir;
  const root = resolve('/');

  while (current !== root) {
    if (
      existsSync(join(current, 'brainrouter.config.json'))
    ) {
      // Make sure it's not the BrainRouter repo itself
      if (resolve(current) !== resolve(GLOBAL_ROOT)) {
        return current;
      }
    }
    current = dirname(current);
  }
  return undefined;
}

/**
 * Read and parse brainrouter.config.json from a directory, if present.
 */
export function readBrainRouterConfig(dir: string): BrainRouterConfig {
  const configPath = join(dir, 'brainrouter.config.json');
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as BrainRouterConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve the final RegistryConfig.
 *
 * Priority:
 *   1. --root <path> CLI flag
 *   2. BRAINROUTER_LOCAL_ROOT env var
 *   3. Auto-detect by walking up from CWD
 *   4. Fallback: single-repo mode (localRoot = globalRoot)
 */
export function resolveRegistryConfig(): RegistryConfig {
  const localRoot =
    parseRootFlag() ??
    (process.env.BRAINROUTER_LOCAL_ROOT
      ? resolve(process.env.BRAINROUTER_LOCAL_ROOT)
      : undefined) ??
    autoDetectLocalRoot(process.cwd()) ??
    GLOBAL_ROOT; // single-repo fallback

  let localProjectName: string | undefined;
  if (localRoot) {
    const config = readBrainRouterConfig(localRoot);
    localProjectName = config.project ?? basename(localRoot);
  }

  return {
    globalRoot: GLOBAL_ROOT,
    localRoot,
    localProjectName,
  };
}
