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
// A41-7: the memory / atlas / fleet / skill-crud / persona / reference / template
// tool HANDLERS moved to ./mcpTools/* (registered there); only the ListTools
// descriptor schemas (and the handlers still living in this switch —
// vulnerability_intelligence, host-learning, session_*, connector_*, knowledge_*)
// are imported here.
import {
  memoryRegisterSkillHintsToolSchema,
  memoryExtractSkillToolSchema,
  memorySkillOutcomeToolSchema,
} from '../tools/skills/index.js';
import {
  memoryRecallToolSchema,
  memorySearchToolSchema,
  memoryRetrieveToolSchema,
  memoryFindRelatedToolSchema,
  memoryGraphQueryToolSchema,
  memoryGraphAnalyticsToolSchema,
  vulnerabilityIntelligenceToolSchema,
} from '../tools/recall/index.js';
import {
  memoryCaptureTurnToolSchema,
  memoryCaptureArtifactToolSchema,
  memoryCaptureAnnotationToolSchema,
  memoryRecordLessonToolSchema,
  memoryCreateRequirementToolSchema,
  memoryIngestRepoToolSchema,
} from '../tools/capture/index.js';
import {
  memoryGovernanceToolSchemas, handleHostLearningRequest,
  memoryEngineeringToolSchemas,
  memoryExplainToolSchema,
  memoryHookToolSchemas,
  memoryContradictionsToolSchema,
  memoryMarkCitedToolSchema,
  memoryProvenanceToolSchema,
  memoryReflectToolSchema,
  memoryReflectSessionToolSchema,
} from '../tools/governance/index.js';
import {
  // session_* handlers migrated to ./mcpTools/session.js (A41-7); descriptors stay.
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
  memoryResolveSessionToolSchema,
} from '../tools/sessions/index.js';
import {
  memoryAgentStatusToolSchema,
  memoryAgentRunToolSchema,
  memoryJobRetryToolSchema,
  memoryBlackboardReviewToolSchema,
} from '../tools/agents/index.js';
import {
  memoryConsolidateToolSchema,
  memoryFetchSourceChunkToolSchema,
  memoryReindexSourceToolSchema,
  memoryPruneSourcesToolSchema,
  memoryVaultExportToolSchema,
} from '../tools/sources/index.js';
import {
  memoryPersonaToolSchema,
  memoryPersonaRefreshToolSchema,
  memoryWorkingToolSchemas,
  memoryCompressToolSchema,
  memoryTreeWalkToolSchema,
  memoryStatsToolSchema,
} from '../tools/working/index.js';
import {
  atlasPutToolSchema, atlasGetToolSchema,
  atlasListToolSchema, atlasQueryToolSchema,
  atlasImpactToolSchema, atlasEnrichToolSchema,
  fleetSnapshotPutToolSchema,
  fleetSnapshotGetToolSchema,
  connectorListToolSchema,
  connectorRunToolSchema,
} from '../tools/atlas/index.js';
import {
  knowledgeListToolSchema,
  knowledgeBaseCreateToolSchema,
  knowledgeIngestToolSchema,
  knowledgeIngestDocxToolSchema,
  knowledgeIngestPdfToolSchema,
  knowledgeStatusToolSchema,
  knowledgeRetryToolSchema,
  knowledgeSearchToolSchema,
} from '../tools/knowledge/index.js';
import {
  // handleWorkspaceProfileRecommend migrated to ./mcpTools/workspace.js (A41-7).
  workspaceProfileRecommendToolSchema,
} from '../tools/workspace/index.js';
// ADR-041 A41-7 — the MCP tool-handler registry (strangler seam). Importing the
// barrel registers every migrated tool; the CallTool dispatcher consults
// `mcpToolHandler(name)` BEFORE the switch, so un-migrated tools fall through.
import { mcpToolHandler, type McpToolHost } from './mcpTools/index.js';

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
      memoryIngestRepoToolSchema,
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
      // ADR-041 A41-7 — the CallTool dispatch is now a pure McpToolRegistry lookup:
      // the 98-case switch has been fully dissolved into ./mcpTools/* registrations.
      // The per-connection closure deps a handler needs travel on `host` (session_*
      // rebuild their hub/claim/notify closures from these five session fields).
      const __migrated = mcpToolHandler(request.params.name);
      if (!__migrated) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
      const host: McpToolHost = {
        registry, isAdmin, defaultUserId, defaultOrgId, connectorWorkspaceRoot, knowledgeActor,
        connectionId: options?.connectionId,
        sessionDeliveryHub: options?.sessionDeliveryHub,
        authorizeOwnedSession,
        validateDeliveryClaim,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionNotify: (wake: any) => server.notification({
          method: SESSION_MESSAGE_NOTIFICATION_METHOD,
          params: wake,
        } as any),
      };
      return await __migrated({ args: request.params.arguments, invokedName: request.params.name, host });
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
