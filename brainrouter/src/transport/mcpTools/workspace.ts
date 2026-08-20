// ADR-041 A41-7 — workspace profile-recommend tool migrated out of the
// mcpServer.ts switch. This handler took the RAW arguments (it parses internally),
// so the body is `handleWorkspaceProfileRecommend(registry, request.params.arguments)`
// verbatim.
import { handleWorkspaceProfileRecommend } from '../../tools/workspace/index.js';
import { registerMcpTool } from './registry.js';

registerMcpTool('workspace_profile_recommend', (ctx) =>
  handleWorkspaceProfileRecommend(ctx.host.registry, ctx.args));
