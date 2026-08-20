// ADR-041 A41-7 — persona / reference / template-doc read tools migrated out of
// the mcpServer.ts switch. Bodies verbatim (`registry` → `ctx.host.registry`,
// `request.params.arguments` → `ctx.args`).
import {
  getPersona, getPersonaSchema,
  getReference, getReferenceSchema,
  listTemplateDocs, listTemplateDocsSchema,
  getTemplateDoc, getTemplateDocSchema,
} from '../../tools/docs/index.js';
import { registerMcpTool } from './registry.js';

registerMcpTool('get_persona', (ctx) => getPersona(ctx.host.registry, getPersonaSchema.parse(ctx.args)));
registerMcpTool('get_reference', (ctx) => getReference(ctx.host.registry, getReferenceSchema.parse(ctx.args)));
registerMcpTool('list_template_docs', (ctx) => listTemplateDocs(ctx.host.registry, listTemplateDocsSchema.parse(ctx.args)));
registerMcpTool('get_template_doc', (ctx) => getTemplateDoc(ctx.host.registry, getTemplateDocSchema.parse(ctx.args)));
