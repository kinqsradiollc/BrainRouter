import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getSafeWorkspacePath } from '../resolver.js';

/**
 * Per-workspace MCP cache directory under the user home, NOT inside the
 * project tree. Mirrors the brainrouter CLI's convention so the workspace
 * tree stays clean of MCP-side state.
 *
 *   ~/.brainrouter/mcp-cache/<workspace-hash>/
 *
 * The hash is sha256(absoluteWorkspacePath).slice(0, 12) so two different
 * workspaces never collide. We don't reuse the CLI's `<basename>-<hash8>`
 * encoding because the MCP and CLI are separate processes — keeping them
 * encoded independently avoids cross-package coupling.
 */
function getMcpCacheDir(workspacePath: string): string {
  const hash = createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
  const dir = path.join(os.homedir(), '.brainrouter', 'mcp-cache', hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const memoryResolveSessionToolSchema = {
  name: 'memory_resolve_session',
  description: 'Resolve and standardize the active session key (Conversation ID). If missing or descriptive, caches and retrieves a stable session UUID in the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      workspacePath: { type: 'string', description: 'The absolute path to the active project workspace.' },
      suggestedKey: { type: 'string', description: 'Optional suggested conversation/session ID from prompt metadata.' },
    },
    required: ['workspacePath'],
  },
};

const resolveSessionSchema = z.object({
  workspacePath: z.string(),
  suggestedKey: z.string().optional(),
});

// Helper to check if a key is a valid non-descriptive unique identifier (like UUID or hex hash)
function isUniqueId(key: string): boolean {
  // UUID pattern
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Simple generic alphanumeric hash (e.g. 16-64 chars, standard for thread IDs, no spaces/hyphens with common words)
  const cleanHashPattern = /^[a-z0-9_-]{16,64}$/i;
  // Reject keys that are purely descriptive natural language words like "datedrop-collab-playlists"
  const containsCommonWords = /playlist|collab|task|feature|debug|collection|datedrop|implement/i;

  if (uuidPattern.test(key)) return true;
  if (cleanHashPattern.test(key) && !containsCommonWords.test(key)) return true;
  return false;
}

export async function handleMemoryResolveSession(args: unknown) {
  const { workspacePath, suggestedKey } = resolveSessionSchema.parse(args);
  const safeWorkspacePath = getSafeWorkspacePath(workspacePath);

  // 1. If suggestedKey is a valid clean unique ID, use it directly
  if (suggestedKey && isUniqueId(suggestedKey)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sessionKey: suggestedKey, source: 'provider_metadata' }, null, 2),
        },
      ],
    };
  }

  // 2. Cache lives in the user-global MCP cache dir, NOT inside the
  // workspace. Writing `<workspace>/.brainrouter/` polluted every project
  // tree, then bounced back through the CLI's legacy-state migration on
  // each restart — a loop the user could see as recurring
  // `.brainrouter/` + `.brainrouter.migrated/` folders.
  let cacheFilePath: string;
  try {
    const cacheDir = getMcpCacheDir(safeWorkspacePath);
    cacheFilePath = path.join(cacheDir, 'active_session.json');
  } catch (err: any) {
    // If the user home itself is unwritable (rare), fall back to a transient
    // UUID rather than touching the workspace tree.
    const fallbackUuid = randomUUID();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sessionKey: fallbackUuid, source: 'fallback_transient', error: err.message }, null, 2),
        },
      ],
    };
  }

  // 3. Read cached session if it exists and is not too old (e.g. within 2 hours, or just stable for the workspace)
  if (fs.existsSync(cacheFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
      if (data && data.sessionKey) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ sessionKey: data.sessionKey, source: 'workspace_cache' }, null, 2),
            },
          ],
        };
      }
    } catch {
      // Ignore parse errors and generate fresh
    }
  }

  // 4. Generate fresh standard UUID session key
  const newSessionKey = randomUUID();
  const sessionData = {
    sessionKey: newSessionKey,
    createdAt: new Date().toISOString(),
    workspace: workspacePath,
    cacheWorkspace: safeWorkspacePath,
  };

  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(sessionData, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`[BrainRouter] Failed to write session cache: ${err.message}`);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ sessionKey: newSessionKey, source: 'new_workspace_generation' }, null, 2),
      },
    ],
  };
}
