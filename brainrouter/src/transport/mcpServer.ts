/**
 * ADR-004 Phase 6 — MCP server factory (transport-agnostic).
 *
 * Extracted VERBATIM from index.ts: builds an MCP `Server` and registers the
 * ListTools + CallTool handlers over the tool registry. index.ts (the bootstrap)
 * now only wires transports (HTTP / stdio) and calls this factory, so the tool
 * surface lives in one place instead of inline in the entrypoint.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, RequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  HOST_LEARNING_REQUEST_METHOD,
  SESSION_MESSAGE_NOTIFICATION_METHOD,
} from '@kinqs/brainrouter-core/mcp';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { Registry } from '../registry.js';
import { isClientDisconnectError } from '../transport-errors.js';
import { recordToolCall } from '../observability/metrics.js';
import { VERSION } from '../version.js';
import { memoryEngine } from '../memory/engine.js';
import { knowledgeActorFromAuth } from '../knowledge/contracts/actor.js';
import type { Role } from '../tenancy/rbac.js';
import type { SessionDeliveryHub } from '../services/sessionDeliveryHub.js';

// Import tools — grouped per domain; each barrel re-exports its modules' public
// surface (schemas + handlers). See tools/<domain>/index.ts.
import {
  listSkills, listSkillsSchema,
  getSkill, getSkillSchema,
  searchSkills, searchSkillsSchema,
  createSkill, createSkillSchema,
  updateSkill, updateSkillSchema,
  memoryRegisterSkillHintsToolSchema, handleMemoryRegisterSkillHints,
  memoryExtractSkillToolSchema, handleMemoryExtractSkill,
  memorySkillOutcomeToolSchema, handleMemorySkillOutcome,
} from '../tools/skills/index.js';
import {
  getPersona, getPersonaSchema,
  getReference, getReferenceSchema,
  listTemplateDocs, listTemplateDocsSchema,
  getTemplateDoc, getTemplateDocSchema,
} from '../tools/docs/index.js';
import {
  memoryRecallToolSchema, handleMemoryRecall,
  memorySearchToolSchema, handleMemorySearch,
  memoryRetrieveToolSchema, handleMemoryRetrieve,
  memoryFindRelatedToolSchema, handleMemoryFindRelated,
  memoryGraphQueryToolSchema, handleMemoryGraphQuery,
  memoryGraphAnalyticsToolSchema, handleMemoryGraphAnalytics,
  vulnerabilityIntelligenceToolSchema, handleVulnerabilityIntelligence,
} from '../tools/recall/index.js';
import {
  memoryCaptureTurnToolSchema, handleMemoryCaptureTurn,
  memoryCaptureArtifactToolSchema, handleMemoryCaptureArtifact,
  memoryCaptureAnnotationToolSchema, handleMemoryCaptureAnnotation,
  memoryRecordLessonToolSchema, handleMemoryRecordLesson,
  memoryCreateRequirementToolSchema, handleMemoryCreateRequirement,
} from '../tools/capture/index.js';
import {
  memoryGovernanceToolSchemas, handleMemoryGovernanceTool, handleHostLearningRequest,
  memoryEngineeringToolSchemas, handleMemoryEngineeringTool,
  memoryExplainToolSchema, handleMemoryExplainRecall,
  memoryHookToolSchemas, handleMemoryHookTool,
  memoryContradictionsToolSchema, handleMemoryContradictions,
  memoryMarkCitedToolSchema, handleMemoryMarkCited,
  memoryProvenanceToolSchema, handleMemoryProvenance,
  memoryReflectToolSchema, handleMemoryReflect,
  memoryReflectSessionToolSchema, handleMemoryReflectSession,
} from '../tools/governance/index.js';
import {
  sessionRegisterToolSchema, handleSessionRegister,
  sessionHeartbeatToolSchema, handleSessionHeartbeat,
  sessionUnregisterToolSchema, handleSessionUnregister,
  sessionListToolSchema, handleSessionList,
  sessionSendToolSchema, handleSessionSend,
  sessionInboxReadToolSchema, handleSessionInboxRead,
  sessionInboxAckToolSchema, handleSessionInboxAck,
  sessionReceiptsToolSchema, handleSessionReceipts,
  sessionReceiptsAckToolSchema, handleSessionReceiptsAck,
  sessionDelegateTaskToolSchema, handleSessionDelegateTask,
  sessionDelegationsToolSchema, handleSessionDelegations,
  memoryResolveSessionToolSchema, handleMemoryResolveSession,
} from '../tools/sessions/index.js';
import {
  memoryAgentStatusToolSchema, handleMemoryAgentStatus,
  memoryAgentRunToolSchema, handleMemoryAgentRun,
  memoryJobRetryToolSchema, handleMemoryJobRetry,
  memoryBlackboardReviewToolSchema, handleMemoryBlackboardReview,
} from '../tools/agents/index.js';
import {
  memoryConsolidateToolSchema, handleMemoryConsolidate,
  memoryFetchSourceChunkToolSchema, handleMemoryFetchSourceChunk,
  memoryReindexSourceToolSchema, handleMemoryReindexSource,
  memoryPruneSourcesToolSchema, handleMemoryPruneSources,
  memoryVaultExportToolSchema, handleMemoryVaultExport,
} from '../tools/sources/index.js';
import {
  memoryPersonaToolSchema, handleMemoryPersona,
  memoryPersonaRefreshToolSchema, handleMemoryPersonaRefresh,
  memoryWorkingToolSchemas, handleMemoryWorkingTool,
  memoryCompressToolSchema, handleMemoryCompress,
  memoryTreeWalkToolSchema, handleMemoryTreeWalk,
  memoryStatsToolSchema, handleMemoryStats,
} from '../tools/working/index.js';
import {
  atlasPutToolSchema, handleAtlasPut, atlasGetToolSchema, handleAtlasGet,
  atlasListToolSchema, handleAtlasList, atlasQueryToolSchema, handleAtlasQuery,
  atlasImpactToolSchema, handleAtlasImpact, atlasEnrichToolSchema, handleAtlasEnrich,
  fleetSnapshotPutToolSchema, handleFleetSnapshotPut,
  fleetSnapshotGetToolSchema, handleFleetSnapshotGet,
  connectorListToolSchema, handleConnectorList,
  connectorRunToolSchema, handleConnectorRun,
} from '../tools/atlas/index.js';
import {
  knowledgeListToolSchema, handleKnowledgeList,
  knowledgeBaseCreateToolSchema, handleKnowledgeBaseCreate,
  knowledgeIngestToolSchema, handleKnowledgeIngest,
  knowledgeIngestDocxToolSchema, handleKnowledgeIngestDocx,
  knowledgeIngestPdfToolSchema, handleKnowledgeIngestPdf,
  knowledgeStatusToolSchema, handleKnowledgeStatus,
  knowledgeRetryToolSchema, handleKnowledgeRetry,
  knowledgeSearchToolSchema, handleKnowledgeSearch,
} from '../tools/knowledge/index.js';
import {
  workspaceProfileRecommendToolSchema, handleWorkspaceProfileRecommend,
} from '../tools/workspace/index.js';

const STDIO_DEFAULT_USER_ID = process.env.BRAINROUTER_USER_ID ?? "default";
const HostLearningRequestSchema = RequestSchema.extend({
  method: z4.literal(HOST_LEARNING_REQUEST_METHOD),
  params: z4.discriminatedUnion("operation", [
    z4.strictObject({ operation: z4.literal("identity") }),
    z4.strictObject({
      operation: z4.literal("correct"),
      input: z4.strictObject({
        itemId: z4.string().regex(/^lrn_[a-f0-9]{18}$/),
        statement: z4.string().trim().min(1).max(400),
        falsifier: z4.string().trim().min(1).max(400),
        expectation: z4.string().trim().min(1).max(400),
      }),
    }),
    z4.strictObject({
      operation: z4.literal("record"),
      input: z4.record(z4.string(), z4.unknown()),
    }),
    z4.strictObject({
      operation: z4.literal("revert"),
      input: z4.record(z4.string(), z4.unknown()),
    }),
    z4.strictObject({
      operation: z4.literal("outcome"),
      input: z4.strictObject({
        recordId: z4.string().trim().min(1).max(200),
        itemId: z4.string().regex(/^lrn_[a-f0-9]{18}$/),
        sessionIdentity: z4.string().regex(/^[a-f0-9]{64}$/),
        outcome: z4.enum(["confirmed", "contradicted"]),
        detail: z4.string().max(240),
      }),
    }),
    z4.strictObject({
      operation: z4.literal("sync"),
      input: z4.record(z4.string(), z4.unknown()),
    }),
    z4.strictObject({
      operation: z4.literal("lifecycle"),
      input: z4.record(z4.string(), z4.unknown()),
    }),
  ]),
});

export interface BuildMcpServerOptions {
  defaultUserId?: string;
  isAdmin?: boolean;
  defaultOrgId?: string;
  defaultRole?: Role;
  /** Stable for one MCP transport; used to reap every bound session on close. */
  connectionId?: string;
  sessionDeliveryHub?: SessionDeliveryHub;
}

const CLAIM_REQUIRED_SESSION_TOOLS = new Set([
  'session_register',
  'session_heartbeat',
  'session_unregister',
  'session_send',
  'session_inbox_read',
  'session_inbox_ack',
  'session_receipts',
  'session_receipts_ack',
]);

export // ─── Server factory ───────────────────────────────────────────────────────────
function buildMcpServer(registry: Registry, options?: BuildMcpServerOptions): Server {
  if (Boolean(options?.connectionId) !== Boolean(options?.sessionDeliveryHub)) {
    throw new Error('MCP session messaging requires both a connection id and delivery hub');
  }
  const defaultUserId = options?.defaultUserId ?? STDIO_DEFAULT_USER_ID;
  const isAdmin = options?.isAdmin ?? false;
  // C1 (ADR-016) — the caller's active org, pinned server-side so recall can
  // surface org-shared memory. Never client-supplied (not in any tool schema).
  const defaultOrgId = options?.defaultOrgId;
  const knowledgeActor = knowledgeActorFromAuth({
    userId: defaultUserId,
    orgId: defaultOrgId,
    role: options?.defaultRole,
    isAdmin,
  });
  const validateDeliveryClaim = options?.connectionId
    ? (binding: { connectionId: string; orgId: string | null; userId: string; sessionKey: string }) =>
        memoryEngine.store.ownsActiveSessionClaim(
          binding.orgId,
          binding.userId,
          binding.sessionKey,
          binding.connectionId,
        )
    : undefined;
  const authorizeOwnedSession = options?.sessionDeliveryHub && options.connectionId
    ? async (orgId: string | null, userId: string, sessionKey: string) =>
        options.sessionDeliveryHub!.owns(options.connectionId!, orgId, userId, sessionKey)
        && await memoryEngine.store.ownsActiveSessionClaim(
          orgId,
          userId,
          sessionKey,
          options.connectionId!,
        )
    : undefined;
  // Connectors are workspace-scoped file state (connectors.json under the
  // BrainRouter home). Use the resolved local workspace root; fall back to cwd.
  const connectorWorkspaceRoot = registry.getLocalRoot() ?? process.cwd();
  const server = new Server(
    { name: 'brainrouter-mcp-server', version: VERSION },
    { capabilities: { tools: {} } }
  );

  // ── Tool list ──────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_skills',
        description: 'List all available skills (global + local merged).',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category folder' },
            scope: { type: 'string', enum: ['global', 'local', 'all'], description: 'Filter by scope' },
          },
        },
      },
      {
        name: 'get_skill',
        description: 'Fetch a specific section of a skill (default: workflow) or read an auxiliary file within the skill directory.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'kebab-case skill name' },
            section: {
              type: 'string',
              enum: [
                'description', 'overview', 'when_to_use', 'workflow', 'usage',
                'detailed_instructions', 'phases', 'checklist', 'red_flags',
                'rationalizations', 'full',
              ],
              description: 'Section to load',
            },
            file: { type: 'string', description: 'Optional filename to read instead of a section (e.g. "examples.md")' },
          },
          required: ['name'],
        },
      },
      {
        name: 'search_skills',
        description: 'Fuzzy search across all skills.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword to search for' },
            scope: { type: 'string', enum: ['global', 'local', 'all'] },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_persona',
        description: 'Fetch a persona definition.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Persona name (e.g. code-reviewer)' },
          },
          required: ['name'],
        },
      },
      workspaceProfileRecommendToolSchema,
      {
        name: 'get_reference',
        description: 'Fetch a reference document.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Reference name (e.g. security-checklist)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'list_template_docs',
        description: 'Compatibility tool for downstream clients: list project-specific template documentation. BrainRouter onboarding uses client-local contracts instead.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['api', 'design', 'schema', 'deployment', 'hooks', 'strategy', 'other'] },
          },
        },
      },
      {
        name: 'get_template_doc',
        description: 'Compatibility tool for downstream clients: read a project template document or section. BrainRouter onboarding uses client-local contracts instead.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Doc name (e.g. api, design)' },
            section: { type: 'string', description: '## heading to load' },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_skill',
        description: 'Scaffold a new skill. If scope is "global", ensure content is universal (replace project-specific terms like "YourProject" with generic ones like "the project") UNLESS the category is a project name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            category: { type: 'string' },
            description: { type: 'string' },
            overview: { type: 'string' },
            when_to_use: { type: 'string' },
            workflow: { type: 'array', items: { type: 'string' } },
            usage: { type: 'string' },
            checklist: { type: 'array', items: { type: 'string' } },
            scope: { type: 'string', enum: ['global', 'local'], description: 'Where to save: "local" (default) or "global" (BrainRouter repo)' },
            project: { type: 'string', description: 'Optional project name for project-specific skills (e.g. "YourProject")' },
          },
          required: ['name', 'category', 'description'],
        },
      },
      {
        name: 'update_skill',
        description: 'Update an existing skill section. Supports "shadowing" global skills locally or updating global skills directly.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            section: { type: 'string', enum: ['overview', 'workflow', 'usage', 'detailed_instructions', 'checklist', 'full'] },
            content: { type: 'string' },
            targetScope: { type: 'string', enum: ['global', 'local'], description: 'Override where to save the update' },
            project: { type: 'string', description: 'Optional project name if elevating to global' },
          },
          required: ['name', 'section', 'content'],
        },
      },
      memoryCaptureTurnToolSchema,
      memoryRecallToolSchema,
      memoryPersonaToolSchema,
      memoryPersonaRefreshToolSchema,
      sessionRegisterToolSchema,
      sessionHeartbeatToolSchema,
      sessionUnregisterToolSchema,
      sessionListToolSchema,
      sessionSendToolSchema,
      sessionInboxReadToolSchema,
      sessionInboxAckToolSchema,
      sessionReceiptsToolSchema,
      sessionReceiptsAckToolSchema,
      sessionDelegateTaskToolSchema,
      sessionDelegationsToolSchema,
      memorySearchToolSchema,
      vulnerabilityIntelligenceToolSchema,
      memoryContradictionsToolSchema,
      memoryRegisterSkillHintsToolSchema,
      memoryResolveSessionToolSchema,
      memoryGraphQueryToolSchema,
      memoryMarkCitedToolSchema,
      ...memoryGovernanceToolSchemas,
      ...memoryEngineeringToolSchemas,
      memoryExplainToolSchema,
      ...memoryHookToolSchemas,
      ...memoryWorkingToolSchemas,
      memoryConsolidateToolSchema,
      memoryAgentStatusToolSchema,
      memoryProvenanceToolSchema,
      memoryFetchSourceChunkToolSchema,
      memoryFindRelatedToolSchema,
      memoryReindexSourceToolSchema,
      memoryRecordLessonToolSchema,
      memoryCreateRequirementToolSchema,
      memoryCaptureArtifactToolSchema,
      memoryCaptureAnnotationToolSchema,
      memoryExtractSkillToolSchema,
      memorySkillOutcomeToolSchema,
      memoryGraphAnalyticsToolSchema,
      memoryReflectToolSchema,
      memoryReflectSessionToolSchema,
      memoryBlackboardReviewToolSchema,
      memoryTreeWalkToolSchema,
      memoryVaultExportToolSchema,
      memoryPruneSourcesToolSchema,
      memoryAgentRunToolSchema,
      memoryJobRetryToolSchema,
      memoryCompressToolSchema,
      memoryRetrieveToolSchema,
      memoryStatsToolSchema,
      atlasPutToolSchema,
      atlasGetToolSchema,
      atlasListToolSchema,
      atlasQueryToolSchema,
      atlasImpactToolSchema,
      atlasEnrichToolSchema,
      fleetSnapshotPutToolSchema,
      fleetSnapshotGetToolSchema,
      connectorListToolSchema,
      connectorRunToolSchema,
      ...(knowledgeActor ? [
        knowledgeListToolSchema,
        knowledgeBaseCreateToolSchema,
        knowledgeIngestToolSchema,
        knowledgeIngestDocxToolSchema,
        knowledgeIngestPdfToolSchema,
        knowledgeStatusToolSchema,
        knowledgeRetryToolSchema,
        knowledgeSearchToolSchema,
      ] : []),
    ],
  }));

  // Learned mutations are protocol-level host lifecycle requests, never MCP
  // tools. The Agent adapter can emit only tools/call, while CLI/Desktop hosts
  // hold this typed request capability directly.
  server.setRequestHandler(HostLearningRequestSchema, async (request) => {
    try {
      return await handleHostLearningRequest(request.params, { defaultUserId, defaultOrgId });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid host learning request: ${error.errors.map((entry) => entry.message).join(', ')}`,
        );
      }
      throw error;
    }
  });

  // ── Tool dispatcher ────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const __startedAt = Date.now();
    try {
      if (CLAIM_REQUIRED_SESSION_TOOLS.has(request.params.name) && !options?.connectionId) {
        const result = {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `${request.params.name} requires a server-owned MCP connection claim`,
          }],
        };
        recordToolCall(request.params.name, false, Date.now() - __startedAt);
        return result;
      }
      // AUTHZ (IDOR fix) — the HTTP /mcp transport authenticates per-user and
      // builds this server with that user's id as `defaultUserId`. A
      // client-supplied `userId` argument must never override it, or one
      // authenticated user (anyone can self-signup) could read/write/delete
      // ANOTHER user's memory (cross-tenant IDOR) — the memory tools scope
      // their SQL to whatever userId is passed, with no ownership recheck, and
      // the REST routes already pin this via scopedUserId. So whenever a tool
      // call carries a `userId`, force it back to the authenticated id. (Only
      // rewrite an EXISTING key, never inject one, so a tool whose schema
      // doesn't accept userId is untouched.) Stdio is single-user → no-op.
      const callArgs = request.params.arguments;
      if (callArgs && typeof callArgs === 'object' && 'userId' in callArgs) {
        (callArgs as Record<string, unknown>).userId = defaultUserId;
      }
      // OBSERVABILITY (Phase 4) — time + count the dispatch. The switch is wrapped
      // in an IIFE so each case's `return` flows to one metrics recording point.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const __result: any = await (async () => {
      switch (request.params.name) {
        case 'list_skills':   return await listSkills(registry, listSkillsSchema.parse(request.params.arguments));
        case 'get_skill':     return await getSkill(registry, getSkillSchema.parse(request.params.arguments));
        case 'search_skills': return await searchSkills(registry, searchSkillsSchema.parse(request.params.arguments));
        case 'get_persona':   return await getPersona(registry, getPersonaSchema.parse(request.params.arguments));
        case 'workspace_profile_recommend':
          return await handleWorkspaceProfileRecommend(registry, request.params.arguments);
        case 'get_reference': return await getReference(registry, getReferenceSchema.parse(request.params.arguments));
        case 'list_template_docs': return await listTemplateDocs(registry, listTemplateDocsSchema.parse(request.params.arguments));
        case 'get_template_doc':   return await getTemplateDoc(registry, getTemplateDocSchema.parse(request.params.arguments));
        case 'create_skill':
        case 'update_skill':
          if (!isAdmin) {
            throw new McpError(ErrorCode.InvalidRequest, 'Admin access required for this tool');
          }
          if (request.params.name === "create_skill") {
            return await createSkill(registry, createSkillSchema.parse(request.params.arguments));
          }
          return await updateSkill(registry, updateSkillSchema.parse(request.params.arguments));
        case 'memory_capture_turn': return await handleMemoryCaptureTurn(request.params.arguments, { defaultUserId, defaultOrgId });
        case 'memory_recall': return await handleMemoryRecall(request.params.arguments, { defaultUserId, defaultOrgId });
        case 'memory_persona': return await handleMemoryPersona(request.params.arguments, { defaultUserId });
        case 'memory_persona_refresh': return await handleMemoryPersonaRefresh(request.params.arguments, { defaultUserId });
        case 'session_register': return await handleSessionRegister(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          onRegistered: options?.sessionDeliveryHub && options.connectionId
            ? (orgId, userId, sessionKey, messageWakeVersion, registrationAttemptId) => {
                const committed = options.sessionDeliveryHub!.commitReservation({
                  connectionId: options.connectionId!,
                  orgId,
                  userId,
                  sessionKey,
                  ...(messageWakeVersion === 1
                    ? {
                        notify: (wake) => server.notification({
                          method: SESSION_MESSAGE_NOTIFICATION_METHOD,
                          params: wake,
                        } as any),
                      }
                    : {}),
                }, registrationAttemptId);
                if (!committed) {
                  throw new Error('the session registration reservation is no longer current');
                }
              }
            : undefined,
          authorizeRegistration: options?.sessionDeliveryHub && options.connectionId
            ? (orgId, userId, sessionKey, registrationAttemptId) => options.sessionDeliveryHub!.reserve(
                options.connectionId!,
                orgId,
                userId,
                sessionKey,
                registrationAttemptId,
              )
            : undefined,
          onRegistrationFailed: options?.sessionDeliveryHub && options.connectionId
            ? (orgId, userId, sessionKey, registrationAttemptId) => options.sessionDeliveryHub!.releaseReservation(
                options.connectionId!,
                orgId,
                userId,
                sessionKey,
                registrationAttemptId,
              )
            : undefined,
        });
        case 'session_heartbeat': return await handleSessionHeartbeat(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_unregister': return await handleSessionUnregister(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          onUnregistered: options?.sessionDeliveryHub && options.connectionId
            ? (orgId, userId, sessionKey) => options.sessionDeliveryHub!.unbind(
                orgId,
                userId,
                sessionKey,
                options.connectionId,
              )
            : undefined,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_list': return await handleSessionList(request.params.arguments, { defaultUserId, defaultOrgId });
        case 'session_send': return await handleSessionSend(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          onPersisted: options?.sessionDeliveryHub
            ? (rows) => options.sessionDeliveryHub!.notifyPersisted(rows, validateDeliveryClaim)
            : undefined,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_inbox_read': return await handleSessionInboxRead(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_inbox_ack': return await handleSessionInboxAck(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_receipts': return await handleSessionReceipts(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_receipts_ack': return await handleSessionReceiptsAck(request.params.arguments, {
          defaultUserId,
          defaultOrgId,
          claimToken: options?.connectionId,
          authorizeSession: authorizeOwnedSession,
        });
        case 'session_delegate_task': return await handleSessionDelegateTask(request.params.arguments, { defaultUserId });
        case 'session_delegations': return await handleSessionDelegations(request.params.arguments, { defaultUserId });
        case 'memory_search': return await handleMemorySearch(request.params.arguments, { defaultUserId, defaultOrgId });
        case 'vulnerability_intelligence': return await handleVulnerabilityIntelligence(request.params.arguments);
        case 'memory_contradictions': return await handleMemoryContradictions(request.params.arguments, { defaultUserId });
        case 'memory_register_skill_hints': return await handleMemoryRegisterSkillHints(request.params.arguments);
        case 'memory_resolve_session': return await handleMemoryResolveSession(request.params.arguments);
        case 'memory_graph_query': return await handleMemoryGraphQuery(request.params.arguments, { defaultUserId });
        case 'memory_mark_cited': return await handleMemoryMarkCited(request.params.arguments, { defaultUserId });
        case 'memory_get':
        case 'memory_update':
        case 'memory_evidence_add':
        case 'memory_evidence_get':
        case 'memory_export':
        case 'memory_import':
        case 'memory_governance_delete':
        case 'memory_audit':
        case 'memory_diagnostics':
        case 'memory_verify_anchors':
          return await handleMemoryGovernanceTool(request.params.name, request.params.arguments, { defaultUserId, defaultOrgId });
        case 'memory_debug_trace_save':
        case 'memory_debug_trace_search':
        case 'memory_failed_attempts':
        case 'memory_file_history':
        case 'memory_task_state':
        case 'memory_task_update':
        case 'memory_handover':
        case 'memory_verify':
          return await handleMemoryEngineeringTool(request.params.name, request.params.arguments, { defaultUserId });
        case 'memory_explain_recall':
          return await handleMemoryExplainRecall(request.params.arguments, { defaultUserId });
        case 'memory_hook_register':
        case 'memory_hook_status':
          return await handleMemoryHookTool(request.params.name, request.params.arguments, { defaultUserId });
        case 'memory_working_context':
        case 'memory_working_offload':
        case 'memory_working_reset':
          return await handleMemoryWorkingTool(request.params.name, request.params.arguments, { defaultUserId });
        case 'memory_consolidate':
          return await handleMemoryConsolidate(request.params.arguments, { defaultUserId });
        case 'memory_agent_status':
          return await handleMemoryAgentStatus(request.params.arguments, { defaultUserId });
        case 'memory_provenance':
          return await handleMemoryProvenance(request.params.arguments, { defaultUserId });
        case 'memory_fetch_source_chunk':
          return await handleMemoryFetchSourceChunk(request.params.arguments, { defaultUserId });
        case 'memory_find_related':
          return await handleMemoryFindRelated(request.params.arguments, { defaultUserId });
        case 'memory_reindex_source':
          return await handleMemoryReindexSource(request.params.arguments, { defaultUserId });
        case 'memory_record_lesson':
          return await handleMemoryRecordLesson(request.params.arguments, { defaultUserId, defaultOrgId });
        case 'memory_create_requirement':
          return await handleMemoryCreateRequirement(request.params.arguments, { defaultUserId });
        case 'memory_capture_artifact':
          return await handleMemoryCaptureArtifact(request.params.arguments, { defaultUserId });
        case 'atlas_put':
          return await handleAtlasPut(request.params.arguments, { defaultUserId });
        case 'atlas_get':
          return await handleAtlasGet(request.params.arguments, { defaultUserId });
        case 'atlas_list':
          return await handleAtlasList(request.params.arguments, { defaultUserId });
        case 'atlas_query':
          return await handleAtlasQuery(request.params.arguments, { defaultUserId });
        case 'atlas_impact':
          return await handleAtlasImpact(request.params.arguments, { defaultUserId });
        case 'atlas_enrich':
          return await handleAtlasEnrich(request.params.arguments, { defaultUserId });
        case 'fleet_snapshot_put':
          return await handleFleetSnapshotPut(request.params.arguments, { defaultUserId });
        case 'fleet_snapshot_get':
          return await handleFleetSnapshotGet(request.params.arguments, { defaultUserId });
        case 'memory_capture_annotation':
          return await handleMemoryCaptureAnnotation(request.params.arguments, { defaultUserId });
        case 'memory_extract_skill':
          return await handleMemoryExtractSkill(request.params.arguments, { defaultUserId });
        case 'memory_skill_outcome':
          // Skill reliability is a GLOBAL registry (no per-user scope), so
          // recording outcomes / re-ranking it is an admin-only governance
          // action — an arbitrary caller must not be able to demote everyone's
          // skills or inflate a bad one (CWE-639). Automatic scoring is driven
          // by trusted internal turn-outcome signals, not this tool.
          if (!isAdmin) {
            throw new McpError(ErrorCode.InvalidRequest, 'Admin access required for this tool');
          }
          return await handleMemorySkillOutcome(request.params.arguments);
        case 'memory_graph_analytics':
          return await handleMemoryGraphAnalytics(request.params.arguments, { defaultUserId });
        case 'memory_reflect':
          return await handleMemoryReflect(request.params.arguments, { defaultUserId });
        case 'memory_reflect_session':
          return await handleMemoryReflectSession(request.params.arguments, { defaultUserId });
        case 'memory_blackboard_review':
          return await handleMemoryBlackboardReview(request.params.arguments, { defaultUserId });
        case 'memory_tree_walk':
          return await handleMemoryTreeWalk(request.params.arguments, { defaultUserId });
        case 'memory_vault_export':
          return await handleMemoryVaultExport(request.params.arguments, { defaultUserId });
        case 'memory_prune_sources':
          return await handleMemoryPruneSources(request.params.arguments, { defaultUserId });
        case 'memory_agent_run':
          return await handleMemoryAgentRun(request.params.arguments, { defaultUserId });
        case 'memory_job_retry':
          return await handleMemoryJobRetry(request.params.arguments, { defaultUserId });
        case 'memory_compress':
          return await handleMemoryCompress(request.params.arguments, { defaultUserId });
        case 'memory_retrieve':
          return await handleMemoryRetrieve(request.params.arguments, { defaultUserId });
        case 'memory_stats':
          return await handleMemoryStats(request.params.arguments, { defaultUserId });
        case 'connector_list':
          return await handleConnectorList(request.params.arguments, { workspaceRoot: connectorWorkspaceRoot });
        case 'connector_run':
          return await handleConnectorRun(request.params.arguments, { workspaceRoot: connectorWorkspaceRoot, defaultUserId });
        case 'knowledge_list':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeList(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_base_create':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeBaseCreate(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_ingest':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeIngest(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_ingest_docx':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeIngestDocx(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_ingest_pdf':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeIngestPdf(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_status':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeStatus(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_retry':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeRetry(request.params.arguments, { actor: knowledgeActor });
        case 'knowledge_search':
          if (!knowledgeActor) throw new McpError(ErrorCode.InvalidRequest, 'Authenticated organization context required for knowledge tools');
          return await handleKnowledgeSearch(request.params.arguments, { actor: knowledgeActor });
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
      })();
      recordToolCall(request.params.name, !(__result && __result.isError), Date.now() - __startedAt);
      return __result;
    } catch (error) {
      recordToolCall(request.params.name, false, Date.now() - __startedAt);
      if (error instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.errors.map(e => e.message).join(', ')}`);
      }
      throw error;
    }
  });

  server.onerror = (error) => {
    // A response that can't be delivered because the client already closed the
    // request stream (cancel / timeout / disconnect) is not a server fault —
    // the handler ran fine, there's just nowhere to send the reply. Downgrade
    // to a quiet warning instead of an alarming [MCP Error] + stack.
    if (isClientDisconnectError(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[BrainRouter] Dropped MCP response to a closed connection (client disconnected before reply): ${msg}`);
      return;
    }
    console.error('[MCP Error]', error);
  };
  return server;
}
