import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

  // 2. Ensure .brainrouter directory exists in the workspace
  const brainrouterDir = path.join(workspacePath, '.brainrouter');
  const cacheFilePath = path.join(brainrouterDir, 'active_session.json');

  try {
    if (!fs.existsSync(brainrouterDir)) {
      fs.mkdirSync(brainrouterDir, { recursive: true });
    }
  } catch (err: any) {
    // If workspace is read-only, fallback to temp directory or generate a transient UUID
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
    workspace: workspacePath
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
