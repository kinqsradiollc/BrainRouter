/**
 * CLI-REINDEX (0.4.5) — keep the brain's code index fresh as the user works.
 *
 * The brain exposes `memory_reindex_source` (MEM-30): pass a file + content and
 * it re-chunks only when the content drifted from what's indexed (a no-op
 * otherwise). The CLI calls it from the file read/edit paths so `find_related`
 * recall stays current without anyone running a manual reindex.
 *
 * To avoid shipping unchanged bytes over MCP on every read, the agent keeps a
 * per-path stat signature and only sends when it changed. This module holds the
 * pure decision pieces (extension allowlist, signature, gate) so they're
 * testable without a store / MCP / filesystem.
 */

/** Extensions we treat as code worth indexing (matches the brain's chunker
 *  language support; everything else is skipped to avoid indexing assets,
 *  lockfiles, and large blobs). */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'rb', 'php', 'swift', 'scala', 'sh', 'bash',
  'sql', 'json', 'yaml', 'yml', 'toml',
]);

/** Lowercased extension without the dot, or '' if none. */
export function fileExtension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True for files whose extension is in the code allowlist. */
export function isReindexableFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(fileExtension(filePath));
}

/** Language hint to pass to the chunker; the bare extension is enough. */
export function languageHint(filePath: string): string {
  return fileExtension(filePath);
}

/** Stable signature for a file's on-disk state — changes iff size or mtime do. */
export function reindexSignature(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

export interface ReindexGate {
  /** `cli.autoReindex` knob. */
  enabled: boolean;
  /** Whether the MCP server is reachable right now. */
  connected: boolean;
  filePath: string;
  /** Current on-disk signature. */
  signature: string;
  /** Last signature we reindexed this path at (undefined = never). */
  lastSignature: string | undefined;
}

/**
 * Decide whether to (re)index this file now. Skips when the feature is off,
 * MCP is offline, the file isn't code, or its content hasn't changed since the
 * last reindex.
 */
export function shouldReindex(gate: ReindexGate): boolean {
  if (!gate.enabled || !gate.connected) return false;
  if (!isReindexableFile(gate.filePath)) return false;
  return gate.signature !== gate.lastSignature;
}
