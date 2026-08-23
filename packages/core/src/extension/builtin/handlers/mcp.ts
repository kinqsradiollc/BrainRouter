// ADR-041 D8 Phase 3 — the MCP read tools, migrated with host METHODS (the
// method-growth counterpart to Phase 2's field-growth). mcp_search / mcp_describe
// / mcp_refresh_catalog read the visible MCP catalogue through three Agent methods
// (visibleMcpToolList / findVisibleMcpTool / serverIdFromMcpToolName); the bodies
// are the former case bodies verbatim (`this.x` → `ctx.host.x`).

import { searchMcpCatalog } from '../../../mcp/discovery/discovery.js';
import { getCliKnobs } from '../../../config/config.js';
import { applyFederationIdentity } from '../../../util/agentloop/federationIdentity.js';
import { evaluatePermissionRules, primaryArgText } from '../../../exec/policy/permissionRules.js';
import { extractToolText } from '../../../mcp/mcpUtils.js';
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

  list_mcp_resources: async ({ args, host }) => {
    const client = host.mcpClient as any;
    if (typeof client.listResources !== 'function') {
      throw new Error('MCP resources are not supported by the active MCP client.');
    }
    const result = await client.listResources({
      cursor: typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : undefined,
      server: typeof args.server === 'string' && args.server.trim() ? args.server.trim() : undefined,
    }, { signal: host.turnAbort?.signal });
    return JSON.stringify(result, null, 2);
  },

  list_mcp_resource_templates: async ({ args, host }) => {
    const client = host.mcpClient as any;
    if (typeof client.listResourceTemplates !== 'function') {
      throw new Error('MCP resource templates are not supported by the active MCP client.');
    }
    const result = await client.listResourceTemplates({
      cursor: typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : undefined,
      server: typeof args.server === 'string' && args.server.trim() ? args.server.trim() : undefined,
    }, { signal: host.turnAbort?.signal });
    return JSON.stringify(result, null, 2);
  },

  read_mcp_resource: async ({ args, host }) => {
    const client = host.mcpClient as any;
    if (typeof client.readResource !== 'function') {
      throw new Error('MCP resource reads are not supported by the active MCP client.');
    }
    const server = String(args.server ?? '').trim();
    const uri = String(args.uri ?? '').trim();
    if (!server) throw new Error('read_mcp_resource requires a server.');
    if (!uri) throw new Error('read_mcp_resource requires a uri.');
    const result = await client.readResource({ server, uri }, { signal: host.turnAbort?.signal });
    return JSON.stringify(result, null, 2);
  },

  mcp_call: async ({ args, host, authorizeMcpTarget }) => {
        const target = String(args.name ?? '').trim();
        if (!target) throw new Error('mcp_call requires a tool `name` (use mcp_search to find one).');
        const tool = await host.findVisibleMcpTool(target);
        host.assertInheritedExecutionAuthorityCurrent();
        if (!tool) throw new Error(`mcp_call: "${target}" is not an available MCP tool. Use mcp_search to find the exact name.`);
        const callArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, any>)
          : {};
        const toolName = String(tool.name);
        const mcpArgs = applyFederationIdentity(toolName, callArgs, host.federationSessionKey) as Record<string, any>;
        authorizeMcpTarget?.(toolName, mcpArgs, tool);
        const permissionNames = [
          toolName,
          String(tool.__rawName ?? '').trim(),
        ].filter((name, index, names) => name && names.indexOf(name) === index);
        if (permissionNames.some((permissionName) => evaluatePermissionRules(
          getCliKnobs().permissions,
          permissionName,
          primaryArgText(permissionName, mcpArgs),
          { workspace: host.workspaceRoot },
        ) === 'deny')) {
          throw new Error(`mcp_call target "${toolName}" denied by cli.permissions.`);
        }
        await host.approveMcpToolCall(toolName, tool, mcpArgs);
        host.assertInheritedExecutionAuthorityCurrent();
        const mcpRes = await host.mcpClient.callTool(toolName, mcpArgs, { signal: host.turnAbort?.signal });
        return extractToolText(mcpRes);
  },
};
