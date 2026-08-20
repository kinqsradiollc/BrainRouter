// ADR-041 A41-7 — connector tools migrated out of the mcpServer.ts switch.
// Bodies verbatim: connectorWorkspaceRoot → ctx.host.connectorWorkspaceRoot,
// defaultUserId → ctx.host.defaultUserId, request.params.arguments → ctx.args.
import { handleConnectorList, handleConnectorRun } from '../../tools/atlas/index.js';
import { registerMcpTool } from './registry.js';

registerMcpTool('connector_list', (ctx) =>
  handleConnectorList(ctx.args, { workspaceRoot: ctx.host.connectorWorkspaceRoot }));
registerMcpTool('connector_run', (ctx) =>
  handleConnectorRun(ctx.args, { workspaceRoot: ctx.host.connectorWorkspaceRoot, defaultUserId: ctx.host.defaultUserId }));
