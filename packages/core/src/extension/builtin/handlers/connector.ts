// ADR-041 D8 Phase 34 — connector_run (execute a configured connector checkpoint, then
// import the freshly-persisted documents into memory). Adds ONE host method,
// agentMcpConnectorClient() — the agent's own MCP client for the `mcp` connector source
// (agent.ts:2680) — plus mcpClient + turnAbort + workspaceRoot, all already on the host.
// Body is the former switch case verbatim (this.x -> ctx.host.x).

import {
  runConnectorCheckpointCore, exportConnectorDocumentsForMemory,
  githubTokenClient, defaultEnvTokenResolver,
} from '../../../connectors/index.js';
import type { BuiltinToolHandler } from './registry.js';

export const connectorHandlers: Record<string, BuiltinToolHandler> = {
  connector_run: async ({ args, host }) => {
        const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
        if (!connectorId) throw new Error('connector_run requires a `connectorId` (see connector_list).');
        // Agent deps: static/dynamic-token GitHub client (NO keychain — oauth
        // github without a token throws the desktop-only guidance in the runner),
        // the agent's own MCP client for the `mcp` source, and env-token creds.
        const runResult = await runConnectorCheckpointCore(host.workspaceRoot, connectorId, {
          envToken: defaultEnvTokenResolver,
          githubClient: (connector) => {
            const cred = defaultEnvTokenResolver(connector, 'GitHub');
            if (!cred.token) return undefined; // → runner throws the OAuth/keychain guidance
            const apiBase = typeof connector.config.baseUrl === 'string' ? connector.config.baseUrl : undefined;
            return githubTokenClient(cred.token, { apiBase });
          },
          mcpClient: () => host.agentMcpConnectorClient(),
        });
        // Import the freshly-persisted documents into memory so future recall can
        // cite them — mirror the host's `indexConnectorMemory` via `memory_import`.
        let importedRecords = 0;
        let importError: string | undefined;
        if (runResult.documents.length > 0) {
          try {
            // Omit sessionKey (mirror the desktop host): connector documents are
            // workspace knowledge, not session-scoped, so future recall in any
            // session can cite them.
            const bundle = exportConnectorDocumentsForMemory(host.workspaceRoot, { connectorId });
            if (bundle.recordCount > 0) {
              const res = await host.mcpClient.callTool('memory_import', { data: bundle.data }, { signal: host.turnAbort?.signal });
              if ((res as { isError?: boolean })?.isError) {
                const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
                importError = typeof text === 'string' ? text : 'memory_import failed.';
              } else {
                importedRecords = bundle.recordCount;
              }
            }
          } catch (err) {
            importError = err instanceof Error ? err.message : String(err);
          }
        }
        const lines = [
          `Connector ${connectorId}: ${runResult.ok ? 'ran' : 'ran with failures'}.`,
          `Documents seen: ${runResult.run.documentsSeen ?? runResult.documents.length}; persisted: ${runResult.documents.length}; imported to memory: ${importedRecords}.`,
        ];
        // Failures are already source-sanitized by the runtimes (repo/channel +
        // HTTP status, never tokens). Cap the list so a broad failure set can't
        // flood the transcript.
        if (runResult.failures.length) {
          lines.push(`Failures (${runResult.failures.length}):`);
          for (const failure of runResult.failures.slice(0, 10)) lines.push(`  - ${failure}`);
          if (runResult.failures.length > 10) lines.push(`  … and ${runResult.failures.length - 10} more.`);
        }
        if (importError) lines.push(`Memory import error: ${importError}`);
        return lines.join('\n');
  },
};
