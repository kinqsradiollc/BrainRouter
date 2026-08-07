import fs from 'node:fs/promises';
import path from 'node:path';
import { stripTrailingSlashes, stripLeadingSlashes } from '../../util/trimEdges.js';
import type {
  ConnectorCheckpoint,
  ConnectorDocument,
  ConnectorRecord,
} from '@kinqs/brainrouter-types';

export interface FilesystemConnectorFileEntry {
  /** Path relative to the listed root, '/'-separated. */
  path: string;
  mtimeMs: number;
  size: number;
}

export interface FilesystemConnectorListOptions {
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export interface FilesystemConnectorClient {
  listFiles(root: string, opts?: FilesystemConnectorListOptions): Promise<FilesystemConnectorFileEntry[]>;
  readFile(filePath: string): Promise<string>;
}

export interface FilesystemConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface FilesystemConnectorRunOptions {
  now?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

export const FILESYSTEM_MAX_FILE_BYTES = 512 * 1024;
export const FILESYSTEM_MAX_FILES_PER_RUN = 2000;

export async function runFilesystemConnectorCheckpoint(
  connector: ConnectorRecord,
  client: FilesystemConnectorClient,
  options?: FilesystemConnectorRunOptions,
): Promise<FilesystemConnectorRunResult> {
  if (connector.source !== 'filesystem') throw new Error(`Connector source ${connector.source} is not filesystem.`);
  const roots = uniqueRoots(configStringList(connector, 'roots'));
  if (roots.length === 0) throw new Error('Filesystem connector requires at least one root folder.');
  const includeGlobs = configStringList(connector, 'includeGlobs');
  const excludeGlobs = configStringList(connector, 'excludeGlobs');
  const maxFiles = Math.max(1, Math.floor(options?.maxFiles ?? FILESYSTEM_MAX_FILES_PER_RUN));
  const maxFileBytes = Math.max(1, Math.floor(options?.maxFileBytes ?? FILESYSTEM_MAX_FILE_BYTES));
  const now = options?.now ?? new Date().toISOString();
  const previous = typeof connector.checkpoint?.highWatermark === 'string' ? connector.checkpoint.highWatermark : undefined;
  const previousMs = previous ? Date.parse(previous) : Number.NaN;

  const failures: string[] = [];
  const candidates: Array<{ root: string; entry: FilesystemConnectorFileEntry }> = [];
  for (const root of roots) {
    try {
      const entries = await client.listFiles(root, { includeGlobs, excludeGlobs });
      for (const entry of entries) {
        const relPath = normalizeRelPath(entry.path);
        if (!relPath) continue;
        if (!matchesGlobs(relPath, includeGlobs, excludeGlobs)) continue;
        if (entry.size > maxFileBytes) continue;
        if (Number.isFinite(previousMs) && entry.mtimeMs <= previousMs) continue;
        candidates.push({ root, entry: { ...entry, path: relPath } });
      }
    } catch (err) {
      failures.push(`${root}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Oldest-first so a truncated run leaves the newest files for the next run,
  // which the mtime high-watermark below then picks up.
  candidates.sort((a, b) => a.entry.mtimeMs - b.entry.mtimeMs || a.entry.path.localeCompare(b.entry.path));
  const processed = candidates.slice(0, maxFiles);
  const remaining = candidates.length - processed.length;

  const documents: ConnectorDocument[] = [];
  for (const { root, entry } of processed) {
    const absPath = joinRootPath(root, entry.path);
    try {
      const text = await client.readFile(absPath);
      if (text.includes('\u0000')) continue; // binary sniff — skip without failing the run
      documents.push(fileDocument(connector, root, absPath, entry, text));
    } catch (err) {
      failures.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (remaining > 0) {
    failures.push(`Truncated at ${maxFiles} files; ${remaining} changed files were not ingested this run.`);
  }

  const processedMaxMs = processed.reduce((max, item) => Math.max(max, item.entry.mtimeMs), Number.NEGATIVE_INFINITY);
  const highWatermark = Number.isFinite(processedMaxMs) ? new Date(processedMaxMs).toISOString() : previous;
  return {
    documents,
    failures,
    checkpoint: {
      ...(highWatermark ? { highWatermark } : {}),
      roots,
      completedAt: now,
      documentCount: documents.length,
      failureCount: failures.length,
    },
  };
}

export interface NodeFsClientOptions {
  maxFileBytes?: number;
}

export function nodeFsClient(options?: NodeFsClientOptions): FilesystemConnectorClient {
  const maxFileBytes = Math.max(1, Math.floor(options?.maxFileBytes ?? FILESYSTEM_MAX_FILE_BYTES));
  return {
    async listFiles(root, opts) {
      const resolvedRoot = await validateRoot(root);
      const entries: FilesystemConnectorFileEntry[] = [];
      await walkDirectory(resolvedRoot, '', opts?.includeGlobs ?? [], opts?.excludeGlobs ?? [], maxFileBytes, entries);
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return entries;
    },
    async readFile(filePath) {
      if (!path.isAbsolute(filePath)) throw new Error(`readFile requires an absolute path; got ${filePath}.`);
      if (filePath.includes('\u0000')) throw new Error('readFile path contains a null byte.');
      return fs.readFile(filePath, 'utf8');
    },
  };
}

export function matchesGlobs(relPath: string, includeGlobs: string[], excludeGlobs: string[]): boolean {
  if (excludeGlobs.some((glob) => globToRegExp(glob).test(relPath))) return false;
  if (includeGlobs.length === 0) return true;
  return includeGlobs.some((glob) => globToRegExp(glob).test(relPath));
}

async function validateRoot(root: string): Promise<string> {
  const trimmed = root.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`Filesystem root must be an absolute path; got ${root || '(empty)'}.`);
  }
  const resolved = path.resolve(trimmed);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Filesystem root ${resolved} is not an accessible directory.`);
  return resolved;
}

async function walkDirectory(
  root: string,
  relDir: string,
  includeGlobs: string[],
  excludeGlobs: string[],
  maxFileBytes: number,
  out: FilesystemConnectorFileEntry[],
): Promise<void> {
  const absDir = relDir ? path.join(root, relDir) : root;
  const dirents = await fs.readdir(absDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue; // never follow links out of the root
    const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (isDirectoryExcluded(rel, excludeGlobs)) continue;
      await walkDirectory(root, rel, includeGlobs, excludeGlobs, maxFileBytes, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!matchesGlobs(rel, includeGlobs, excludeGlobs)) continue;
    const stat = await fs.stat(path.join(absDir, dirent.name)).catch(() => undefined);
    if (!stat || stat.size > maxFileBytes) continue;
    out.push({ path: rel, mtimeMs: stat.mtimeMs, size: stat.size });
  }
}

function isDirectoryExcluded(relDir: string, excludeGlobs: string[]): boolean {
  return excludeGlobs.some((glob) => {
    if (globToRegExp(glob).test(relDir)) return true;
    return glob.endsWith('/**') && globToRegExp(glob.slice(0, -3)).test(relDir);
  });
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const pattern = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  const re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

function fileDocument(
  connector: ConnectorRecord,
  root: string,
  absPath: string,
  entry: FilesystemConnectorFileEntry,
  text: string,
): ConnectorDocument {
  // Note: ids are relPath-scoped, so the same relative path under two roots
  // maps to one document; `repository` keeps the winning root visible.
  return {
    id: `filesystem:${connector.id}:${entry.path}`,
    connectorId: connector.id,
    source: 'filesystem',
    kind: 'file',
    repository: root,
    title: entry.path,
    url: `file://${absPath}`,
    updatedAt: new Date(entry.mtimeMs).toISOString(),
    text,
    metadata: { root, path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs },
  };
}

function joinRootPath(root: string, relPath: string): string {
  return `${stripTrailingSlashes(root)}/${relPath}`;
}

function normalizeRelPath(value: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return undefined;
  if (normalized.split('/').some((segment) => segment === '..' || segment === '' || segment === '.')) return undefined;
  return normalized;
}

function uniqueRoots(roots: string[]): string[] {
  const unique: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique;
}

function configStringList(connector: ConnectorRecord, key: string): string[] {
  const value = connector.config[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}
