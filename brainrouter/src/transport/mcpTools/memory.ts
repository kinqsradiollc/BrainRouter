// ADR-041 A41-7 — the memory / atlas / fleet tool family migrated out of the
// mcpServer.ts switch. Every body is the switch case verbatim: the RAW arguments
// (`request.params.arguments` → `ctx.args`) and the scope object built from
// `defaultUserId`/`defaultOrgId` (→ `ctx.host.defaultUserId`/`ctx.host.defaultOrgId`).
// The multi-case blocks (governance/engineering/hook/working) pass the invoked
// name through `ctx.invokedName`, exactly as the fallthrough passed
// `request.params.name`.
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  handleMemoryRecall,
  handleMemorySearch,
  handleMemoryRetrieve,
  handleMemoryFindRelated,
  handleMemoryGraphQuery,
  handleMemoryGraphAnalytics,
  handleVulnerabilityIntelligence,
} from '../../tools/recall/index.js';
import {
  handleMemoryCaptureTurn,
  handleMemoryCaptureArtifact,
  handleMemoryCaptureAnnotation,
  handleMemoryRecordLesson,
  handleMemoryCreateRequirement,
} from '../../tools/capture/index.js';
import {
  handleMemoryGovernanceTool,
  handleMemoryEngineeringTool,
  handleMemoryExplainRecall,
  handleMemoryHookTool,
  handleMemoryContradictions,
  handleMemoryMarkCited,
  handleMemoryProvenance,
  handleMemoryReflect,
  handleMemoryReflectSession,
} from '../../tools/governance/index.js';
import {
  handleMemoryResolveSession,
} from '../../tools/sessions/index.js';
import {
  handleMemoryAgentStatus,
  handleMemoryAgentRun,
  handleMemoryJobRetry,
  handleMemoryBlackboardReview,
} from '../../tools/agents/index.js';
import {
  handleMemoryConsolidate,
  handleMemoryFetchSourceChunk,
  handleMemoryReindexSource,
  handleMemoryPruneSources,
  handleMemoryVaultExport,
} from '../../tools/sources/index.js';
import {
  handleMemoryPersona,
  handleMemoryPersonaRefresh,
  handleMemoryWorkingTool,
  handleMemoryCompress,
  handleMemoryTreeWalk,
  handleMemoryStats,
} from '../../tools/working/index.js';
import {
  handleMemoryRegisterSkillHints,
  handleMemoryExtractSkill,
  handleMemorySkillOutcome,
} from '../../tools/skills/index.js';
import {
  handleAtlasPut,
  handleAtlasGet,
  handleAtlasList,
  handleAtlasQuery,
  handleAtlasImpact,
  handleAtlasEnrich,
  handleFleetSnapshotPut,
  handleFleetSnapshotGet,
} from '../../tools/atlas/index.js';
import { registerMcpTool } from './registry.js';

// ── (args, { defaultUserId, defaultOrgId }) ──────────────────────────────────
registerMcpTool('memory_capture_turn', (ctx) =>
  handleMemoryCaptureTurn(ctx.args, { defaultUserId: ctx.host.defaultUserId, defaultOrgId: ctx.host.defaultOrgId }));
registerMcpTool('memory_recall', (ctx) =>
  handleMemoryRecall(ctx.args, { defaultUserId: ctx.host.defaultUserId, defaultOrgId: ctx.host.defaultOrgId }));
registerMcpTool('memory_search', (ctx) =>
  handleMemorySearch(ctx.args, { defaultUserId: ctx.host.defaultUserId, defaultOrgId: ctx.host.defaultOrgId }));
registerMcpTool('memory_record_lesson', (ctx) =>
  handleMemoryRecordLesson(ctx.args, { defaultUserId: ctx.host.defaultUserId, defaultOrgId: ctx.host.defaultOrgId }));

// ── governance block: (name, args, { defaultUserId, defaultOrgId }) ──────────
for (const name of [
  'memory_get', 'memory_update', 'memory_evidence_add', 'memory_evidence_get',
  'memory_export', 'memory_import', 'memory_governance_delete', 'memory_audit',
  'memory_diagnostics', 'memory_verify_anchors',
]) {
  registerMcpTool(name, (ctx) =>
    handleMemoryGovernanceTool(ctx.invokedName, ctx.args, { defaultUserId: ctx.host.defaultUserId, defaultOrgId: ctx.host.defaultOrgId }));
}

// ── engineering block: (name, args, { defaultUserId }) ───────────────────────
for (const name of [
  'memory_debug_trace_save', 'memory_debug_trace_search', 'memory_failed_attempts',
  'memory_file_history', 'memory_task_state', 'memory_task_update', 'memory_handover',
  'memory_verify',
]) {
  registerMcpTool(name, (ctx) =>
    handleMemoryEngineeringTool(ctx.invokedName, ctx.args, { defaultUserId: ctx.host.defaultUserId }));
}

// ── hook block: (name, args, { defaultUserId }) ──────────────────────────────
for (const name of ['memory_hook_register', 'memory_hook_status']) {
  registerMcpTool(name, (ctx) =>
    handleMemoryHookTool(ctx.invokedName, ctx.args, { defaultUserId: ctx.host.defaultUserId }));
}

// ── working block: (name, args, { defaultUserId }) ───────────────────────────
for (const name of ['memory_working_context', 'memory_working_offload', 'memory_working_reset']) {
  registerMcpTool(name, (ctx) =>
    handleMemoryWorkingTool(ctx.invokedName, ctx.args, { defaultUserId: ctx.host.defaultUserId }));
}

// ── (args, { defaultUserId }) ────────────────────────────────────────────────
registerMcpTool('memory_persona', (ctx) => handleMemoryPersona(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_persona_refresh', (ctx) => handleMemoryPersonaRefresh(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_contradictions', (ctx) => handleMemoryContradictions(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_graph_query', (ctx) => handleMemoryGraphQuery(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_mark_cited', (ctx) => handleMemoryMarkCited(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_explain_recall', (ctx) => handleMemoryExplainRecall(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_consolidate', (ctx) => handleMemoryConsolidate(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_agent_status', (ctx) => handleMemoryAgentStatus(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_provenance', (ctx) => handleMemoryProvenance(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_fetch_source_chunk', (ctx) => handleMemoryFetchSourceChunk(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_find_related', (ctx) => handleMemoryFindRelated(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_reindex_source', (ctx) => handleMemoryReindexSource(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_create_requirement', (ctx) => handleMemoryCreateRequirement(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_capture_artifact', (ctx) => handleMemoryCaptureArtifact(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_capture_annotation', (ctx) => handleMemoryCaptureAnnotation(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_extract_skill', (ctx) => handleMemoryExtractSkill(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_graph_analytics', (ctx) => handleMemoryGraphAnalytics(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_reflect', (ctx) => handleMemoryReflect(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_reflect_session', (ctx) => handleMemoryReflectSession(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_blackboard_review', (ctx) => handleMemoryBlackboardReview(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_tree_walk', (ctx) => handleMemoryTreeWalk(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_vault_export', (ctx) => handleMemoryVaultExport(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_prune_sources', (ctx) => handleMemoryPruneSources(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_agent_run', (ctx) => handleMemoryAgentRun(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_job_retry', (ctx) => handleMemoryJobRetry(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_compress', (ctx) => handleMemoryCompress(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_retrieve', (ctx) => handleMemoryRetrieve(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('memory_stats', (ctx) => handleMemoryStats(ctx.args, { defaultUserId: ctx.host.defaultUserId }));

// ── atlas / fleet: (args, { defaultUserId }) ─────────────────────────────────
registerMcpTool('atlas_put', (ctx) => handleAtlasPut(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('atlas_get', (ctx) => handleAtlasGet(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('atlas_list', (ctx) => handleAtlasList(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('atlas_query', (ctx) => handleAtlasQuery(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('atlas_impact', (ctx) => handleAtlasImpact(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('atlas_enrich', (ctx) => handleAtlasEnrich(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('fleet_snapshot_put', (ctx) => handleFleetSnapshotPut(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('fleet_snapshot_get', (ctx) => handleFleetSnapshotGet(ctx.args, { defaultUserId: ctx.host.defaultUserId }));

// ── (args) only ──────────────────────────────────────────────────────────────
registerMcpTool('memory_register_skill_hints', (ctx) => handleMemoryRegisterSkillHints(ctx.args));
registerMcpTool('memory_resolve_session', (ctx) => handleMemoryResolveSession(ctx.args));
registerMcpTool('vulnerability_intelligence', (ctx) => handleVulnerabilityIntelligence(ctx.args));

// ── admin-gated (args): skill reliability is a GLOBAL registry — recording
// outcomes / re-ranking is an admin-only governance action (CWE-639). Gate
// re-asserted verbatim from the former switch case.
registerMcpTool('memory_skill_outcome', async (ctx) => {
  if (!ctx.host.isAdmin) {
    throw new McpError(ErrorCode.InvalidRequest, 'Admin access required for this tool');
  }
  return await handleMemorySkillOutcome(ctx.args);
});
