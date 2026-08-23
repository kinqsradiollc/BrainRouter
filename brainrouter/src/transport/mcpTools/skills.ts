// ADR-041 A41-7 — skill CRUD tools migrated out of the mcpServer.ts switch.
// Each body is the switch case verbatim (`registry` → `ctx.host.registry`,
// `request.params.arguments` → `ctx.args`, `isAdmin` → `ctx.host.isAdmin`).
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  listSkills, listSkillsSchema,
  getSkill, getSkillSchema,
  searchSkills, searchSkillsSchema,
  createSkill, createSkillSchema,
  updateSkill, updateSkillSchema,
} from '../../tools/skills/index.js';
import { registerMcpTool } from './registry.js';

registerMcpTool('list_skills', (ctx) => listSkills(ctx.host.registry, listSkillsSchema.parse(ctx.args)));
registerMcpTool('get_skill', (ctx) => getSkill(ctx.host.registry, getSkillSchema.parse(ctx.args)));
registerMcpTool('search_skills', (ctx) => searchSkills(ctx.host.registry, searchSkillsSchema.parse(ctx.args)));

// create_skill / update_skill shared the same admin gate in the switch; each
// registration re-asserts it before dispatching (byte-identical to the fallthrough).
registerMcpTool('create_skill', async (ctx) => {
  if (!ctx.host.isAdmin) {
    throw new McpError(ErrorCode.InvalidRequest, 'Admin access required for this tool');
  }
  return await createSkill(ctx.host.registry, createSkillSchema.parse(ctx.args));
});
registerMcpTool('update_skill', async (ctx) => {
  if (!ctx.host.isAdmin) {
    throw new McpError(ErrorCode.InvalidRequest, 'Admin access required for this tool');
  }
  return await updateSkill(ctx.host.registry, updateSkillSchema.parse(ctx.args));
});
