#!/usr/bin/env node
// ─────────────────────────────────────────────
// BrainRouter MCP Server — Entry Point
// ─────────────────────────────────────────────
//
// Supports two transport modes:
//
//   stdio (default)
//     The AI tool spawns this process and communicates via stdin/stdout.
//     No URL, no port. Tool manages the lifecycle.
//     Usage: node dist/index.js --root /path/to/project
//
//   HTTP (--http flag)
//     Runs an Express HTTP server. Connect via serverUrl in tool config.
//     Usage: node dist/index.js --root /path/to/project --http --port 3747
//
//   init subcommand
//     Scaffold ~/.config/brainrouter/server.env from the bundled
//     .env.example and exit. Run this once after a global install.
//     Usage: brainrouter-mcp init
//

// CRITICAL: import order matters. `init` may exit the process before
// anything else loads (for `brainrouter-mcp init`). `env-loader` runs next
// and sets process.env from the right .env file before any module body
// reads env vars (sqlite/embedding/extractor all do at load time).
import './init.js';
import './env-loader.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import fs from "node:fs";

import { Registry } from './registry.js';
import { resolveRegistryConfig } from './resolver.js';

// Import tools
import { listSkills, listSkillsSchema } from './tools/list_skills.js';
import { getSkill, getSkillSchema } from './tools/get_skill.js';
import { searchSkills, searchSkillsSchema } from './tools/search_skills.js';
import { getPersona, getPersonaSchema } from './tools/get_persona.js';
import { getReference, getReferenceSchema } from './tools/get_reference.js';
import { listTemplateDocs, listTemplateDocsSchema } from './tools/list_template_docs.js';
import { getTemplateDoc, getTemplateDocSchema } from './tools/get_template_doc.js';
import { createSkill, createSkillSchema } from './tools/create_skill.js';
import { updateSkill, updateSkillSchema } from './tools/update_skill.js';
import { memoryCaptureTurnToolSchema, handleMemoryCaptureTurn } from './tools/memory_capture_turn.js';
import { memoryRecallToolSchema, handleMemoryRecall } from './tools/memory_recall.js';
import {
  memoryPersonaToolSchema,
  handleMemoryPersona,
  memoryPersonaRefreshToolSchema,
  handleMemoryPersonaRefresh,
} from './tools/memory_persona.js';
import {
  sessionRegisterToolSchema,
  handleSessionRegister,
  sessionHeartbeatToolSchema,
  handleSessionHeartbeat,
  sessionUnregisterToolSchema,
  handleSessionUnregister,
  sessionListToolSchema,
  handleSessionList,
} from './tools/active_sessions.js';
import {
  sessionSendToolSchema,
  handleSessionSend,
  sessionInboxReadToolSchema,
  handleSessionInboxRead,
  sessionInboxAckToolSchema,
  handleSessionInboxAck,
} from './tools/session_inbox.js';
import { memorySearchToolSchema, handleMemorySearch } from './tools/memory_search.js';
import { memoryContradictionsToolSchema, handleMemoryContradictions } from './tools/memory_contradictions.js';
import { memoryRegisterSkillHintsToolSchema, handleMemoryRegisterSkillHints } from './tools/memory_register_skill_hints.js';
import { memoryResolveSessionToolSchema, handleMemoryResolveSession } from './tools/memory_resolve_session.js';
import { memoryGraphQueryToolSchema, handleMemoryGraphQuery } from './tools/memory_graph_query.js';
import { memoryMarkCitedToolSchema, handleMemoryMarkCited } from './tools/memory_mark_cited.js';
import { memoryGovernanceToolSchemas, handleMemoryGovernanceTool } from './tools/memory-governance.js';
import { memoryEngineeringToolSchemas, handleMemoryEngineeringTool } from './tools/memory-engineering.js';
import { memoryExplainToolSchema, handleMemoryExplainRecall } from './tools/memory-explain.js';
import { memoryHookToolSchemas, handleMemoryHookTool } from './tools/memory-hooks.js';
import { memoryWorkingToolSchemas, handleMemoryWorkingTool } from './tools/memory-working.js';
import { memoryConsolidateToolSchema, handleMemoryConsolidate } from './tools/memory_consolidate.js';
import { memoryAgentStatusToolSchema, handleMemoryAgentStatus } from './tools/memory_agent_status.js';
import { memoryAgentRunToolSchema, handleMemoryAgentRun } from './tools/memory_agent_run.js';
import { memoryJobRetryToolSchema, handleMemoryJobRetry } from './tools/memory_job_retry.js';
import { memoryEngine } from './memory/engine.js';
import path from 'node:path';
import { decideMcpAcceptPromotion } from './api/mcpAcceptHeader.js';
import { usersRouter } from './api/routes/users.js';
import { memoriesRouter } from './api/routes/memories.js';
import { scenesRouter } from './api/routes/scenes.js';
import { personaRouter } from './api/routes/persona.js';
import { sessionsRouter } from './api/routes/sessions.js';
import { contradictionsRouter } from './api/routes/contradictions.js';
import { statsRouter } from './api/routes/stats.js';
import { brainRouter } from './api/routes/brain.js';
import { graphRouter } from './api/routes/graph.js';
import { authRouter } from './api/routes/auth.js';
import { chatCompletionsRouter } from './api/routes/chat-completions.js';
import { governanceRouter } from './api/routes/governance.js';
import { evidenceRouter } from './api/routes/evidence.js';
import { hooksRouter } from './api/routes/hooks.js';
import { workingRouter } from './api/routes/working.js';
import { skillsRouter } from './api/routes/skills.js';
import { USING_FALLBACK_JWT_SECRET } from './api/middleware/auth.js';
const STDIO_DEFAULT_USER_ID = process.env.BRAINROUTER_USER_ID ?? "default";

const authAttempts = new Map<string, { count: number; resetAt: number }>();

function authRateLimit(req: Request, res: Response, next: () => void) {
  const now = Date.now();
  const key = req.ip ?? "unknown";
  const current = authAttempts.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + 15 * 60 * 1000 };
  bucket.count += 1;
  authAttempts.set(key, bucket);
  if (bucket.count > 20) {
    res.status(429).json({ error: "Too many authentication attempts" });
    return;
  }
  next();
}

// ─── CLI flags ────────────────────────────────────────────────────────────────
function parseFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const USE_HTTP = process.argv.includes('--http');
const PORT = parseInt(parseFlag('--port') ?? '3747', 10);

// ─── Server factory ───────────────────────────────────────────────────────────
function buildMcpServer(registry: Registry, options?: { defaultUserId?: string; isAdmin?: boolean }): Server {
  const defaultUserId = options?.defaultUserId ?? STDIO_DEFAULT_USER_ID;
  const isAdmin = options?.isAdmin ?? false;
  const server = new Server(
    { name: 'brainrouter-mcp-server', version: '0.3.8' },
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
        description: 'List all project-specific template documentation.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['api', 'design', 'schema', 'deployment', 'hooks', 'strategy', 'other'] },
          },
        },
      },
      {
        name: 'get_template_doc',
        description: 'Read a project template document or section.',
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
      memorySearchToolSchema,
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
      memoryAgentRunToolSchema,
      memoryJobRetryToolSchema,
    ],
  }));

  // ── Tool dispatcher ────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      switch (request.params.name) {
        case 'list_skills':   return await listSkills(registry, listSkillsSchema.parse(request.params.arguments));
        case 'get_skill':     return await getSkill(registry, getSkillSchema.parse(request.params.arguments));
        case 'search_skills': return await searchSkills(registry, searchSkillsSchema.parse(request.params.arguments));
        case 'get_persona':   return await getPersona(registry, getPersonaSchema.parse(request.params.arguments));
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
        case 'memory_capture_turn': return await handleMemoryCaptureTurn(request.params.arguments, { defaultUserId });
        case 'memory_recall': return await handleMemoryRecall(request.params.arguments, { defaultUserId });
        case 'memory_persona': return await handleMemoryPersona(request.params.arguments, { defaultUserId });
        case 'memory_persona_refresh': return await handleMemoryPersonaRefresh(request.params.arguments, { defaultUserId });
        case 'session_register': return await handleSessionRegister(request.params.arguments, { defaultUserId });
        case 'session_heartbeat': return await handleSessionHeartbeat(request.params.arguments, { defaultUserId });
        case 'session_unregister': return await handleSessionUnregister(request.params.arguments, { defaultUserId });
        case 'session_list': return await handleSessionList(request.params.arguments, { defaultUserId });
        case 'session_send': return await handleSessionSend(request.params.arguments, { defaultUserId });
        case 'session_inbox_read': return await handleSessionInboxRead(request.params.arguments, { defaultUserId });
        case 'session_inbox_ack': return await handleSessionInboxAck(request.params.arguments, { defaultUserId });
        case 'memory_search': return await handleMemorySearch(request.params.arguments, { defaultUserId });
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
          return await handleMemoryGovernanceTool(request.params.name, request.params.arguments, { defaultUserId });
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
        case 'memory_agent_run':
          return await handleMemoryAgentRun(request.params.arguments, { defaultUserId });
        case 'memory_job_retry':
          return await handleMemoryJobRetry(request.params.arguments, { defaultUserId });
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.errors.map(e => e.message).join(', ')}`);
      }
      throw error;
    }
  });

  server.onerror = (error) => console.error('[MCP Error]', error);
  return server;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const config = resolveRegistryConfig();
const registry = new Registry(config);
registry.build();

// Auto-scan skills dirs for memory_hints on startup
const skillsDirsToScan = [
  path.join(config.globalRoot, 'skills'),
  config.localRoot ? path.join(config.localRoot, 'skills') : undefined,
].filter((d): d is string => !!d); // remove undefined and deduplicate
const uniqueSkillsDirs = [...new Set(skillsDirsToScan)];
memoryEngine.autoScanSkillHints(uniqueSkillsDirs);

if (USE_HTTP) {
  // ── HTTP / Streamable-HTTP transport ────────────────────────────────────────
  // Each client session gets its own Server + Transport instance.
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  // Tracks which User-Agents we've already warned about for missing
  // `text/event-stream` in their Accept header — one warning per UA
  // so a chatty client doesn't drown the logs.
  const warnedUserAgents = new Set<string>();

  const app = express();
  
  // Custom CORS middleware to support cross-origin requests from Dashboard
  app.use((req, res, next) => {
    const allowedOrigin = process.env.BRAINROUTER_CORS_ORIGIN || "http://localhost:3000";
    const requestOrigin = req.headers.origin;
    if (!requestOrigin || requestOrigin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin ?? allowedOrigin);
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json());
  if (USING_FALLBACK_JWT_SECRET) {
    console.error("[BrainRouter] WARNING: running with generated JWT secret. Set BRAINROUTER_JWT_SECRET in production.");
  }

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', root: config.localRoot });
  });

  app.use("/api/auth/signin", authRateLimit);
  app.use("/api/auth/signup", authRateLimit);
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/memories", memoriesRouter);
  app.use("/api/scenes", scenesRouter);
  app.use("/api/persona", personaRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/contradictions", contradictionsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/brain", brainRouter);
  app.use("/api/graph", graphRouter);
  app.use("/api", governanceRouter);
  app.use("/api/evidence", evidenceRouter);
  app.use("/api/hooks", hooksRouter);
  app.use("/api/working", workingRouter);
  app.use("/api/skills", skillsRouter);
  // OpenAI-compatible chat endpoint (memory-augmented):
  //   POST /v1/chat/completions  — standard OpenAI body, sessionKey via body.brainrouter.sessionKey or X-BrainRouter-Session header
  //   GET  /v1/models            — returns the configured upstream model
  app.use("/v1", chatCompletionsRouter);

  // MCP endpoint — handles POST (requests) and GET (SSE stream).
  //
  // The Streamable HTTP MCP SDK strictly requires every POST to send
  // `Accept: application/json, text/event-stream` because the response
  // could be either a plain JSON body or an SSE stream. Naive clients
  // (curl, fetch without explicit headers, older MCP SDK builds, some
  // health-check probes) often send only `application/json` and the
  // SDK rejects them with a `Not Acceptable` 406 — surfacing as a
  // noisy error in the brain logs that operators can't easily map
  // back to the offending client.
  //
  // We promote `Accept: application/json` → `Accept: application/json,
  // text/event-stream` *before* delegating to the SDK so the request
  // proceeds, then log a one-time warning per User-Agent so the
  // operator can find and fix the misbehaving client. This is safe:
  // the SDK only enters SSE mode if the handler explicitly streams,
  // which never happens for the JSON-only request shapes the naive
  // clients send.
  function promoteAcceptHeader(req: Request): void {
    if (req.method !== 'POST') return;
    const decision = decideMcpAcceptPromotion(
      typeof req.headers.accept === 'string' ? req.headers.accept : '',
    );
    if (!decision.promote) return;
    req.headers.accept = decision.value;
    const ua = (req.headers['user-agent'] as string | undefined) ?? '(no user-agent)';
    if (!warnedUserAgents.has(ua)) {
      warnedUserAgents.add(ua);
      console.error(
        `[BrainRouter] MCP client missing 'text/event-stream' in Accept header — promoting transparently. ` +
          `Update the client to send 'Accept: application/json, text/event-stream' on every POST to /mcp. ` +
          `User-Agent: ${ua}`,
      );
    }
  }

  async function handleMcp(req: Request, res: Response) {
    promoteAcceptHeader(req);
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const authHeader = req.headers.authorization;
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!bearerKey) {
      res.status(401).json({ error: 'API key required. Set Authorization: Bearer <your_api_key>' });
      return;
    }
    const user = memoryEngine.getUserByApiKey(bearerKey);
    if (!user) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }
    if (user.status === "disabled") {
      res.status(403).json({ error: "Account disabled" });
      return;
    }
    const effectiveUserId = user.userId;

    if (req.method === 'POST' && !sessionId) {
      // New session — initialise
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server: mcpServer, transport });
        },
      });

      const mcpServer = buildMcpServer(registry, { defaultUserId: effectiveUserId, isAdmin: user.isAdmin });

      transport.onclose = () => {
        const id = [...sessions.entries()].find(([, v]) => v.transport === transport)?.[0];
        if (id) sessions.delete(id);
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Existing session
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({ error: 'Session not found. Send a POST without mcp-session-id to initialise.' });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
  }

  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);

  // DELETE — client-side session teardown
  app.delete('/mcp', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) sessions.delete(sessionId);
    res.status(204).send();
  });

  const dashboardDist = path.resolve(process.cwd(), "..", "dashboard", "dist");
  if (fs.existsSync(dashboardDist)) {
    app.use("/dashboard", express.static(dashboardDist));
    app.get("/dashboard/*", (_req: Request, res: Response) => {
      res.sendFile(path.join(dashboardDist, "index.html"));
    });
  }

  const httpServer = app.listen(PORT, () => {
    console.log(`\n🧠 BrainRouter MCP Server`);
    console.log(`   Transport : HTTP (Streamable)`);
    console.log(`   Endpoint  : http://localhost:${PORT}/mcp`);
    console.log(`   Health    : http://localhost:${PORT}/health`);
    console.log(`   Root      : ${config.localRoot}\n`);
  });

  process.on('SIGINT', () => {
    httpServer.close(() => process.exit(0));
  });

} else {
  // ── stdio transport (default) ───────────────────────────────────────────────
  
  // Redirect console.log and console.warn to stderr to avoid polluting stdout.
  // In stdio mode, stdout is strictly reserved for the MCP protocol.
  console.log = (...args) => console.error(...args);
  console.warn = (...args) => console.error(...args);

  // Authenticate user via environment variable or CLI flag
  let stdioUserId = "";
  let stdioIsAdmin = false;
  
  const stdioApiKey = (process.env.BRAINROUTER_API_KEY ?? parseFlag('--apiKey'))?.trim();
  if (!stdioApiKey) {
    console.error("[BrainRouter] FATAL: Connection aborted. Authentication is strictly required for all tool operations.");
    console.error("[BrainRouter] To fix this, please configure BRAINROUTER_API_KEY inside your MCP client config environment variables.");
    console.error("[BrainRouter] Example configuration:");
    console.error(JSON.stringify({
      mcpServers: {
        brainrouter: {
          command: "node",
          args: [
            "/absolute/path/to/BrainRouter/brainrouter/dist/index.js",
            "--root",
            "/absolute/path/to/your/workspace"
          ],
          env: {
            BRAINROUTER_API_KEY: "br_YOUR_API_KEY"
          }
        }
      }
    }, null, 2));
    process.exit(1);
  }

  const user = memoryEngine.getUserByApiKey(stdioApiKey);
  if (!user) {
    console.error("[BrainRouter] FATAL: The provided BRAINROUTER_API_KEY is invalid. Connection aborted.");
    process.exit(1);
  }
  if (user.status === "disabled") {
    console.error("[BrainRouter] FATAL: The provided BRAINROUTER_API_KEY belongs to a disabled account.");
    process.exit(1);
  }
  
  stdioUserId = user.userId;
  stdioIsAdmin = user.isAdmin;
  console.error(`[BrainRouter] Authenticated via BRAINROUTER_API_KEY. Mapping local session to user: ${user.displayName || user.userId}`);

  const server = buildMcpServer(registry, { defaultUserId: stdioUserId, isAdmin: stdioIsAdmin });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('BrainRouter MCP server running on stdio');

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}
