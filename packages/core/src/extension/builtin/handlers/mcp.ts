// ADR-041 D8 Phase 3 — the MCP read tools, migrated with host METHODS (the
// method-growth counterpart to Phase 2's field-growth). mcp_search / mcp_describe
// / mcp_refresh_catalog read the visible MCP catalogue through three Agent methods
// (visibleMcpToolList / findVisibleMcpTool / serverIdFromMcpToolName); the bodies
// are the former case bodies verbatim (`this.x` → `ctx.host.x`).

import { searchMcpCatalog } from '../../../mcp/discovery/discovery.js';
import type { BuiltinToolHandler } from './registry.js';

export const mcpHandlers: Record<string, BuiltinToolHandler> = {
  mcp_search: async ({ args, host }) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('mcp_search requires a non-empty `query`.');
    const maxResults = Math.max(1, Math.min(25, Number(args.maxResults ?? 8)));
    const tools = await host.visibleMcpToolList();
    const matches = searchMcpCatalog(tools, query, maxResults);
    return JSON.stringify({ query, count: matches.length, tools: matches }, null, 2);
  },

  mcp_describe: async ({ args, host }) => {
    const names: string[] = Array.isArray(args.names)
      ? args.names.map((n: any) => String(n))
      : args.name != null ? [String(args.name)] : [];
    if (names.length === 0) throw new Error('mcp_describe requires `name` or `names`.');
    const out: Array<Record<string, unknown>> = [];
    for (const target of names) {
      const tool = await host.findVisibleMcpTool(target);
      if (!tool) {
        out.push({ name: target, error: 'not found or not an available MCP tool' });
        continue;
      }
      out.push({ name: String(tool.name), description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} });
    }
    return JSON.stringify(out, null, 2);
  },

  mcp_refresh_catalog: async ({ host }) => {
    const tools = await host.visibleMcpToolList();
    const byServer: Record<string, number> = {};
    for (const t of tools) {
      const server = String(t?.__serverId ?? host.serverIdFromMcpToolName(String(t?.name ?? '')) ?? 'unknown');
      byServer[server] = (byServer[server] ?? 0) + 1;
    }
    return JSON.stringify({ totalTools: tools.length, servers: byServer }, null, 2);
  },
};
