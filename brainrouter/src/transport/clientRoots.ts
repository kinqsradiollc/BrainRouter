/**
 * The workspace an MCP CLIENT is working in, from the roots it declares.
 *
 * BrainRouter's own CLI and desktop fill in `workspaceTags` on every memory
 * read, because they know where they are. An agent that reaches the brain as
 * an ordinary MCP server — the documented install for other coding agents —
 * sends none, so its searches ranked every repository alike. MCP already has
 * the answer: a client declares its workspace folders as `roots`, and the
 * server may ask for them.
 *
 * So for the two reads that rank by workspace, a call that brings no scope of
 * its own gets the client's roots, hashed exactly as the CLI hashes a folder.
 * It is a PREFERENCE on those reads, never a filter, so a client whose roots
 * are wrong loses ordering, not results.
 *
 * Bounded on purpose: `roots/list` is a request to the client, and a client
 * that never answers must not stall a memory call. It is asked once per
 * connection, with a short timeout, and the answer — including "none" — is
 * kept until the client says its roots changed. A remote brain cannot read the
 * client's git remote, so this gives the folder identity only.
 */
import { fileURLToPath } from "node:url";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";

export const SCOPED_MEMORY_READS: ReadonlySet<string> = new Set(["memory_search", "memory_recall"]);
/** A client that has not answered by then is treated as having no roots. */
export const ROOTS_TIMEOUT_MS = 1_500;
/** The memory tools accept at most this many identities. */
const MAX_TAGS = 8;

/** `file://` roots → folder tags. Anything else names no local folder. */
export function tagsFromRoots(roots: ReadonlyArray<{ uri?: unknown }>): string[] {
  const tags: string[] = [];
  for (const root of roots) {
    if (typeof root?.uri !== "string" || !root.uri.startsWith("file://")) continue;
    let folder: string;
    try {
      folder = fileURLToPath(root.uri);
    } catch {
      continue;
    }
    const tag = workspaceTagFromPath(folder);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

export interface ClientRootsScope {
  tags(): Promise<string[]>;
  /** The client said its roots changed. */
  invalidate(): void;
}

export function createClientRootsScope(
  fetchRoots: () => Promise<ReadonlyArray<{ uri?: unknown }>>,
  clientSupportsRoots: () => boolean,
): ClientRootsScope {
  let cached: Promise<string[]> | null = null;
  return {
    tags() {
      if (!clientSupportsRoots()) return Promise.resolve([]);
      // A failure is cached too: a client that could not answer once would
      // otherwise cost every later memory call the full timeout.
      cached ??= fetchRoots().then(tagsFromRoots, () => []);
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}

/**
 * Add the client's workspace to a scoped memory read that did not bring one.
 * A caller that sent its own `workspaceTags` knows better and is left alone.
 */
export async function withClientRootsScope(
  toolName: string,
  args: unknown,
  scope: Pick<ClientRootsScope, "tags">,
): Promise<unknown> {
  if (!SCOPED_MEMORY_READS.has(toolName)) return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const call = args as Record<string, unknown>;
  if (Array.isArray(call.workspaceTags) && call.workspaceTags.length > 0) return args;
  const tags = await scope.tags();
  return tags.length > 0 ? { ...call, workspaceTags: tags } : args;
}
