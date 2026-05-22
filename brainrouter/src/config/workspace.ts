import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceInfo {
  launchCwd: string;
  workspaceRoot: string;
  reason: string;
}

const ROOT_MARKERS = ['AGENT.md', 'AGENTS.md', '.git'];

export function findWorkspaceRoot(startDir = process.cwd()): WorkspaceInfo {
  const launchCwd = fs.realpathSync(startDir);
  const envRoot = process.env.BRAINROUTER_WORKSPACE;
  if (envRoot) {
    return {
      launchCwd,
      workspaceRoot: fs.realpathSync(path.resolve(envRoot)),
      reason: 'BRAINROUTER_WORKSPACE',
    };
  }

  const markerRoot = findNearestMarkerRoot(launchCwd);
  if (markerRoot) {
    const monorepoRoot = maybePromoteBrainRouterPackage(markerRoot);
    return {
      launchCwd,
      workspaceRoot: monorepoRoot.root,
      reason: monorepoRoot.reason,
    };
  }

  return {
    launchCwd,
    workspaceRoot: launchCwd,
    reason: 'cwd',
  };
}

export function applyWorkspaceRoot(workspaceRoot: string): void {
  process.chdir(workspaceRoot);
}

function findNearestMarkerRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (ROOT_MARKERS.some(marker => fs.existsSync(path.join(current, marker)))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function maybePromoteBrainRouterPackage(root: string): { root: string; reason: string } {
  const parent = path.dirname(root);
  const packageJsonPath = path.join(parent, 'package.json');
  if (
    path.basename(root) === 'brainrouter' &&
    fs.existsSync(path.join(parent, 'AGENT.md')) &&
    fs.existsSync(packageJsonPath)
  ) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const workspaces = Array.isArray(packageJson.workspaces) ? packageJson.workspaces : [];
      if (workspaces.includes('brainrouter') || workspaces.includes('brainrouter/*')) {
        return { root: fs.realpathSync(parent), reason: 'parent monorepo workspace' };
      }
    } catch {
      // Keep the original marker root if package.json is unreadable.
    }
  }

  return { root, reason: 'nearest workspace marker' };
}
