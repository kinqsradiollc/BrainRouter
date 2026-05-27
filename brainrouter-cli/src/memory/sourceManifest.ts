import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface SourceManifestEntry {
  path: string;
  mtimeMs: number;
  hash: string;
  size: number;
  kind: string;
  title: string;
}

export interface SourceManifestResult {
  workspaceRoot: string;
  scannedAt: string;
  entries: SourceManifestEntry[];
  skipped: {
    directories: number;
    largeFiles: number;
    unsupportedFiles: number;
  };
}

const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  '__pycache__',
  '.DS_Store',
  'coverage',
]);

const SUPPORTED_EXTS = new Set([
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.rb', '.php',
  '.sh', '.bash', '.zsh', '.sql', '.css', '.scss',
]);

function kindFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.mdx' || ext === '.txt') return 'doc';
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') return 'config';
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'script';
  return 'code';
}

function titleFor(relPath: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(relPath);
}

export function scanWorkspaceSources(
  workspaceRoot: string,
  options: { limit?: number; maxFileBytes?: number } = {},
): SourceManifestResult {
  const limit = Math.max(1, options.limit ?? 200);
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? 512 * 1024);
  const root = fs.realpathSync(workspaceRoot);
  const entries: SourceManifestEntry[] = [];
  const skipped = { directories: 0, largeFiles: 0, unsupportedFiles: 0 };

  const walk = (dir: string) => {
    if (entries.length >= limit) return;
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      if (entries.length >= limit) return;
      if (EXCLUDED_DIRS.has(name)) {
        skipped.directories++;
        continue;
      }
      const abs = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) {
        skipped.unsupportedFiles++;
        continue;
      }
      if (stat.size > maxFileBytes) {
        skipped.largeFiles++;
        continue;
      }
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        skipped.unsupportedFiles++;
        continue;
      }
      const rel = path.relative(root, abs);
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      entries.push({
        path: rel,
        mtimeMs: Math.floor(stat.mtimeMs),
        hash,
        size: stat.size,
        kind: kindFor(rel),
        title: titleFor(rel, content),
      });
    }
  };

  walk(root);
  return {
    workspaceRoot: root,
    scannedAt: new Date().toISOString(),
    entries,
    skipped,
  };
}
