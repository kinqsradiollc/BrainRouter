// ADR-041 A41-7 — the org-scoped knowledge tools migrated out of the mcpServer.ts
// switch. Every case shared the same guard-then-dispatch shape, so a small helper
// re-asserts the actor gate verbatim (the identical McpError) before each handler.
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  handleKnowledgeList,
  handleKnowledgeBaseCreate,
  handleKnowledgeIngest,
  handleKnowledgeIngestDocx,
  handleKnowledgeIngestPdf,
  handleKnowledgeStatus,
  handleKnowledgeRetry,
  handleKnowledgeSearch,
} from '../../tools/knowledge/index.js';
import type { KnowledgeActor } from '../../knowledge/contracts/actor.js';
import { registerMcpTool, type McpToolContext } from './registry.js';

type KnowledgeHandler = (args: unknown, options: { actor: KnowledgeActor }) => Promise<unknown>;

// Register a knowledge tool with the actor gate the switch applied to every case.
function registerKnowledgeTool(name: string, handler: KnowledgeHandler): void {
  registerMcpTool(name, (ctx: McpToolContext) => {
    if (!ctx.host.knowledgeActor) {
      throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
    }
    return handler(ctx.args, { actor: ctx.host.knowledgeActor });
  });
}

registerKnowledgeTool('knowledge_list', handleKnowledgeList);
registerKnowledgeTool('knowledge_base_create', handleKnowledgeBaseCreate);
registerKnowledgeTool('knowledge_ingest', handleKnowledgeIngest);
registerKnowledgeTool('knowledge_ingest_docx', handleKnowledgeIngestDocx);
registerKnowledgeTool('knowledge_ingest_pdf', handleKnowledgeIngestPdf);
registerKnowledgeTool('knowledge_status', handleKnowledgeStatus);
registerKnowledgeTool('knowledge_retry', handleKnowledgeRetry);
registerKnowledgeTool('knowledge_search', handleKnowledgeSearch);
