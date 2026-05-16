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

import { Registry } from './registry.js';
import { resolveRegistryConfig } from './resolver.js';

// Import tools
import { listSkills, listSkillsSchema } from './tools/list_skills.js';
import { getSkill, getSkillSchema } from './tools/get_skill.js';
import { searchSkills, searchSkillsSchema } from './tools/search_skills.js';
import { getPersona, getPersonaSchema } from './tools/get_persona.js';
import { getReference, getReferenceSchema } from './tools/get_reference.js';
import { listDocs, listDocsSchema } from './tools/list_docs.js';
import { getDoc, getDocSchema } from './tools/get_doc.js';
import { createSkill, createSkillSchema } from './tools/create_skill.js';
import { updateSkill, updateSkillSchema } from './tools/update_skill.js';

// ─── CLI flags ────────────────────────────────────────────────────────────────
function parseFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const USE_HTTP = process.argv.includes('--http');
const PORT = parseInt(parseFlag('--port') ?? '3747', 10);

// ─── Server factory ───────────────────────────────────────────────────────────
function buildMcpServer(registry: Registry): Server {
  const server = new Server(
    { name: 'brainrouter-mcp-server', version: '0.1.0' },
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
        name: 'list_docs',
        description: 'List all project-specific documentation.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['api', 'design', 'schema', 'deployment', 'hooks', 'strategy', 'other'] },
          },
        },
      },
      {
        name: 'get_doc',
        description: 'Read a project document or section.',
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
        case 'list_docs':     return await listDocs(registry, listDocsSchema.parse(request.params.arguments));
        case 'get_doc':       return await getDoc(registry, getDocSchema.parse(request.params.arguments));
        case 'create_skill':  return await createSkill(registry, createSkillSchema.parse(request.params.arguments));
        case 'update_skill':  return await updateSkill(registry, updateSkillSchema.parse(request.params.arguments));
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

if (USE_HTTP) {
  // ── HTTP / Streamable-HTTP transport ────────────────────────────────────────
  // Each client session gets its own Server + Transport instance.
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', root: config.localRoot });
  });

  // MCP endpoint — handles POST (requests) and GET (SSE stream)
  async function handleMcp(req: Request, res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST' && !sessionId) {
      // New session — initialise
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server: mcpServer, transport });
        },
      });

      const mcpServer = buildMcpServer(registry);

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

  app.listen(PORT, () => {
    console.log(`\n🧠 BrainRouter MCP Server`);
    console.log(`   Transport : HTTP (Streamable)`);
    console.log(`   Endpoint  : http://localhost:${PORT}/mcp`);
    console.log(`   Health    : http://localhost:${PORT}/health`);
    console.log(`   Root      : ${config.localRoot}\n`);
  });

  process.on('SIGINT', () => process.exit(0));

} else {
  // ── stdio transport (default) ───────────────────────────────────────────────
  const server = buildMcpServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('BrainRouter MCP server running on stdio');

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}
