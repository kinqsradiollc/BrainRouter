// ADR-041 A41-7 — the MCP tool registry barrel. Importing this module for its
// side effects registers every migrated MCP tool handler (see registry.ts for the
// strangler seam). mcpServer.ts imports this once, then consults `mcpToolHandler`
// before its switch. Add a new domain module's import here when you migrate it.
import './skills.js';
import './docs.js';
import './workspace.js';

export {
  type McpToolHost,
  type McpToolContext,
  type McpToolHandler,
  registerMcpTool,
  mcpToolHandler,
  registeredMcpToolNames,
} from './registry.js';
