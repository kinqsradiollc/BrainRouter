import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { AssuranceCoverageLimitation } from '@kinqs/brainrouter-types/review';

const SAMPLE_BYTES = 8 * 1024;

export interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  size: number | null;
  path: string;
}

export interface SourceInventoryLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface SourceInventory {
  fileCount: number;
  textFileCount: number;
  unsupportedFileCount: number;
  byteCount: number;
  eligiblePaths: string[];
  limitations: AssuranceCoverageLimitation[];
}

export function parseGitTreeEntries(output: string): GitTreeEntry[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const metadata = record.slice(0, tab).split(/\s+/);
      const size = metadata[3] === '-' ? null : Number(metadata[3]);
      if (tab < 0 || metadata.length !== 4 || !Number.isFinite(size ?? 0) || !record.slice(tab + 1)) {
        throw new Error('SOURCE_INVENTORY_INVALID');
      }
      return {
        mode: metadata[0],
        type: metadata[1],
        objectId: metadata[2],
        size,
        path: record.slice(tab + 1),
      };
    });
}

function absoluteSourcePath(sourceRoot: string, relativePath: string): string {
  const candidate = resolve(sourceRoot, relativePath);
  const prefix = sourceRoot.endsWith(sep) ? sourceRoot : `${sourceRoot}${sep}`;
  if (candidate !== sourceRoot && !candidate.startsWith(prefix)) {
    throw new Error('SOURCE_PATH_ESCAPE');
  }
  return candidate;
}

async function looksTextual(path: string): Promise<boolean> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function inventorySourceTree(
  sourceRoot: string,
  entries: GitTreeEntry[],
  limits: SourceInventoryLimits,
): Promise<SourceInventory> {
  const limitations: AssuranceCoverageLimitation[] = [];
  const blobs = entries.filter((entry) => entry.type === 'blob');
  const candidateBlobs = blobs.filter((entry) => entry.mode !== '120000');
  const byteCount = blobs.reduce((total, entry) => total + (entry.size ?? 0), 0);
  const eligiblePaths: string[] = [];
  let unsupportedFileCount = entries.length - candidateBlobs.length;

  if (blobs.length > limits.maxFiles) {
    limitations.push({
      id: 'source-file-limit',
      component: 'checkout_inventory',
      state: 'partial',
      reasonCode: 'SOURCE_FILE_LIMIT',
      summary: `Only ${limits.maxFiles} of ${blobs.length} source files are eligible for indexing.`,
    });
  }
  if (byteCount > limits.maxBytes) {
    limitations.push({
      id: 'source-byte-limit',
      component: 'checkout_inventory',
      state: 'partial',
      reasonCode: 'SOURCE_BYTE_LIMIT',
      summary: `Repository source exceeds the ${limits.maxBytes}-byte inventory limit.`,
    });
  }

  let acceptedBytes = 0;
  for (const entry of candidateBlobs) {
    if (eligiblePaths.length >= limits.maxFiles) break;
    if (acceptedBytes + (entry.size ?? 0) > limits.maxBytes) continue;
    const path = absoluteSourcePath(sourceRoot, entry.path);
    let textual = false;
    try {
      textual = await looksTextual(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ELOOP' && code !== 'EMLINK') throw error;
    }
    if (!textual) {
      unsupportedFileCount += 1;
      continue;
    }
    eligiblePaths.push(entry.path);
    acceptedBytes += entry.size ?? 0;
  }

  if (unsupportedFileCount > 0) {
    limitations.push({
      id: 'source-unsupported-entries',
      component: 'checkout_inventory',
      state: 'unsupported',
      reasonCode: 'SOURCE_ENTRY_UNSUPPORTED',
      summary: `${unsupportedFileCount} binary, symbolic-link, submodule, or unsupported entries were excluded.`,
    });
  }

  return {
    fileCount: blobs.length,
    textFileCount: eligiblePaths.length,
    unsupportedFileCount,
    byteCount,
    eligiblePaths,
    limitations,
  };
}
