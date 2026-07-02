/**
 * Connector MCP tools — `connector_list` + `connector_run`.
 *
 * These give a REMOTE MCP-speaking agent the same connector surface the
 * chat/CLI agent has: list the workspace's configured connectors and run one's
 * ingest → memory checkpoint. The per-source runtime + full orchestration live
 * in `@kinqs/brainrouter-core/connectors` (shared with the desktop host and the
 * CLI agent); this file is a thin MCP adapter that:
 *   1. runs the checkpoint via core's `runConnectorCheckpointCore` (env-token
 *      GitHub client, no keychain — OAuth/keychain connectors are desktop-only),
 *   2. exports the freshly-persisted documents with `exportConnectorDocumentsForMemory`,
 *   3. imports them into the server's memory engine.
 *
 * Credentials are read only from the env var named by the connector's
 * `credential.ref` (static mode). Tokens are never echoed — failures reported by
 * the runtimes are source-sanitized (repo/channel + HTTP status).
 */
import { z } from 'zod';
import {
  listConnectors,
  runConnectorCheckpointCore,
  exportConnectorDocumentsForMemory,
  githubTokenClient,
  defaultEnvTokenResolver,
} from '@kinqs/brainrouter-core/connectors';
import { memoryEngine } from '../memory/engine.js';

/** Resolve the workspace root the connector state (connectors.json) is scoped to. */
function connectorWorkspaceRoot(options?: { workspaceRoot?: string }): string {
  return options?.workspaceRoot?.trim() || process.cwd();
}

function toolResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function toolError(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

// ── connector_list ───────────────────────────────────────────────────────────

export const connectorListToolSchema = {
  name: 'connector_list',
  description:
    'List the connectors configured for this workspace (GitHub, filesystem, web, Slack, Jira, Confluence, Notion, Linear, GitLab, Google Drive, Gmail, MCP). Read-only. Returns each connector\'s id, source, status, when it last ran, and its last error. Use it to discover what you can ingest before calling connector_run.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Optional: filter to one source (e.g. "github", "filesystem").' },
      status: {
        type: 'string',
        enum: ['active', 'paused', 'error', 'deleting'],
        description: 'Optional: filter by connector status.',
      },
    },
  },
} as const;

export async function handleConnectorList(args: unknown, options?: { workspaceRoot?: string }) {
  const params = z
    .object({
      source: z.string().optional(),
      status: z.enum(['active', 'paused', 'error', 'deleting']).optional(),
    })
    .parse(args ?? {});
  const workspaceRoot = connectorWorkspaceRoot(options);
  try {
    const connectors = listConnectors(workspaceRoot, {
      source: params.source as never,
      status: params.status as never,
    }).map((connector) => ({
      id: connector.id,
      source: connector.source,
      status: connector.status,
      lastRunAt: connector.lastRunAt ?? null,
      lastError: connector.lastError ?? null,
    }));
    return toolResult(connectors);
  } catch (err) {
    return toolError(`connector_list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── connector_run ────────────────────────────────────────────────────────────

export const connectorRunToolSchema = {
  name: 'connector_run',
  description:
    'Run one connector\'s ingest → memory checkpoint: fetch new documents from the source, persist them, and import them into memory so future recall can cite them. Does network I/O and writes memory. Credentials are read only from the workspace connector config (static environment-token mode); connectors using OAuth/keychain credentials must be run from BrainRouter Desktop. Returns a summary of documents seen/indexed and any (sanitized) failures.',
  inputSchema: {
    type: 'object',
    properties: {
      connectorId: { type: 'string', description: 'The connector id to run (from connector_list).' },
    },
    required: ['connectorId'],
  },
} as const;

export async function handleConnectorRun(args: unknown, options?: { workspaceRoot?: string; defaultUserId?: string }) {
  const params = z.object({ connectorId: z.string().min(1) }).parse(args);
  const workspaceRoot = connectorWorkspaceRoot(options);
  const userId = options?.defaultUserId ?? 'default';

  try {
    const runResult = await runConnectorCheckpointCore(workspaceRoot, params.connectorId, {
      envToken: defaultEnvTokenResolver,
      githubClient: (connector) => {
        const cred = defaultEnvTokenResolver(connector, 'GitHub');
        if (!cred.token) return undefined; // → runner throws the OAuth/keychain guidance
        const apiBase = typeof connector.config.baseUrl === 'string' ? connector.config.baseUrl : undefined;
        return githubTokenClient(cred.token, { apiBase });
      },
      // No MCP resource client available in the MCP-server process → the `mcp`
      // connector source reports a clear "no MCP client" error from the runner.
    });

    let importedRecords = 0;
    let importError: string | undefined;
    if (runResult.documents.length > 0) {
      try {
        const bundle = exportConnectorDocumentsForMemory(workspaceRoot, { connectorId: params.connectorId, userId });
        if (bundle.recordCount > 0) {
          await memoryEngine.importMemories(userId, bundle.data as never);
          importedRecords = bundle.recordCount;
        }
      } catch (err) {
        importError = err instanceof Error ? err.message : String(err);
      }
    }

    return toolResult({
      connectorId: params.connectorId,
      ok: runResult.ok,
      documentsSeen: runResult.run.documentsSeen ?? runResult.documents.length,
      documentsPersisted: runResult.documents.length,
      importedToMemory: importedRecords,
      // Failures are already source-sanitized by the runtimes (never tokens).
      failures: runResult.failures.slice(0, 20),
      failureCount: runResult.failures.length,
      ...(importError ? { memoryImportError: importError } : {}),
    });
  } catch (err) {
    return toolError(`connector_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
