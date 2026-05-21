import fs from 'node:fs';
import path from 'node:path';

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function getCliStateDir(workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const stateDir = path.join(root, '.brainrouter', 'cli');
  if (!isPathInside(root, stateDir)) {
    throw new Error('CLI state directory escapes workspace root.');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

export function getCliStateFile(workspaceRoot: string, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error(`Invalid CLI state file name: ${fileName}`);
  }

  const stateDir = getCliStateDir(workspaceRoot);
  const filePath = path.join(stateDir, fileName);
  if (!isPathInside(stateDir, filePath)) {
    throw new Error(`CLI state file escapes state directory: ${fileName}`);
  }
  return filePath;
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw new Error(`Failed to read CLI state file ${filePath}: ${err.message}`);
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
