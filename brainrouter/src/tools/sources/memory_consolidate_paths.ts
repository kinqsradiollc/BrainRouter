import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../../brainrouter-home.js';
import { getSafeWorkspacePath } from '../../resolver.js';

export function resolveConsolidationWorkspace(workspacePath: string): string {
  const safeWorkspacePath = getSafeWorkspacePath(workspacePath);
  const brainrouterWorkRoot = path.join(getBrainrouterHome(), 'work');
  const resolved = path.resolve(safeWorkspacePath);
  const relativeToWork = path.relative(brainrouterWorkRoot, resolved);
  if (relativeToWork && !relativeToWork.startsWith('..') && !path.isAbsolute(relativeToWork)) {
    throw new Error(
      'workspacePath points at BrainRouter transient working memory, not a project workspace. ' +
      'Pass the real project root, for example /Users/anhdang/Documents/Github/BrainRouter.'
    );
  }
  return resolved;
}

export function getMemoryConsolidationDir(workspaceRoot: string): string {
  return path.join(getWorkspaceStateRoot(workspaceRoot), 'memories');
}

function getWorkspaceStateRoot(workspaceRoot: string): string {
  const abs = fs.realpathSync(workspaceRoot);
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  const encoded = `${base.slice(0, 60)}-${hash}`;
  const dir = path.join(getBrainrouterHome(), 'workspaces', encoded);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
