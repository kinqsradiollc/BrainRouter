import { Agent } from './agent.js';
import type { McpClientWrapper } from './mcpClient.js';
import type { LLMConfig } from './config.js';
import {
  createSession,
  formatSessionSummary,
  getSession,
  listSessions,
  updateSession,
  type ChildSessionRecord,
} from './orchestrator.js';
import { buildRolePrompt, resolveRole, type AccessMode } from './agentRoles.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from './systemPrompt.js';
import { readTranscriptEntries } from './sessionStore.js';
import { callMcpTool, childSessionKey } from './mcpUtils.js';

export interface OrchestrationContext {
  workspaceRoot: string;
  parentSessionKey: string;
  mcpClient: McpClientWrapper;
  llmConfig: LLMConfig;
  launchCwd: string;
}

// Threshold above which a child agent's final output is offloaded to the
// BrainRouter working-memory canvas rather than embedded directly in the
// parent's context. ~6k chars ≈ 1.5k tokens — enough room for short reports
// in-line, big enough that a 20k-char architecture analysis goes out-of-band.
const OFFLOAD_THRESHOLD_CHARS = 6000;
const OFFLOAD_PREVIEW_CHARS = 800;

const ORCHESTRATION_TOOL_NAMES = new Set([
  'spawn_agent',
  'list_agents',
  'wait_agent',
  'read_agent_transcript',
  'close_agent',
]);

export function isOrchestrationToolName(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name);
}

const runningPromises = new Map<string, Promise<void>>();

export function trackedPromiseFor(id: string): Promise<void> | undefined {
  return runningPromises.get(id);
}

export function createSpawnAgentTool() {
  return {
    name: 'spawn_agent',
    description: 'Spawn a child agent with a specific role (explorer, architect, reviewer, worker, verifier) and a bounded prompt. Returns the child agent id immediately; the child runs in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        wait: { type: 'boolean', description: 'If true, block until the child completes and return its final output. Default: false.' },
        timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds when wait=true. Default 120000.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled. The child agent is told to build on these instead of re-discovering them.',
        },
      },
      required: ['role', 'prompt'],
    },
  };
}

export function createListAgentsTool() {
  return {
    name: 'list_agents',
    description: 'List all child agent sessions for the current workspace with status, role, and elapsed time.',
    inputSchema: { type: 'object', properties: {} },
  };
}

export function createWaitAgentTool() {
  return {
    name: 'wait_agent',
    description: 'Wait for a child agent to complete. Returns final output, error, or timeout state.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id returned by spawn_agent.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait time in ms. Default 120000.' },
      },
      required: ['id'],
    },
  };
}

export function createReadAgentTranscriptTool() {
  return {
    name: 'read_agent_transcript',
    description: 'Read recent transcript entries (default 40) of a child agent session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id.' },
        limit: { type: 'integer', description: 'Max entries to return. Default 40.' },
      },
      required: ['id'],
    },
  };
}

export function createCloseAgentTool() {
  return {
    name: 'close_agent',
    description: 'Mark a child agent session closed without deleting its transcript. Use this for cleanup.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Child agent id.' } },
      required: ['id'],
    },
  };
}

export async function executeOrchestrationTool(
  name: string,
  args: any,
  ctx: OrchestrationContext,
): Promise<string> {
  switch (name) {
    case 'spawn_agent':
      return await handleSpawn(args, ctx);
    case 'list_agents':
      return handleList(ctx);
    case 'wait_agent':
      return await handleWait(args, ctx);
    case 'read_agent_transcript':
      return handleReadTranscript(args, ctx);
    case 'close_agent':
      return handleClose(args, ctx);
    default:
      throw new Error(`Unknown orchestration tool: ${name}`);
  }
}

async function handleSpawn(args: any, ctx: OrchestrationContext): Promise<string> {
  const role = resolveRole(String(args.role));
  const prompt = String(args.prompt ?? '');
  if (!prompt.trim()) throw new Error('spawn_agent requires a non-empty prompt.');

  const access = (args.access as AccessMode | undefined) ?? role.defaultAccess;
  const record = createSession(ctx.workspaceRoot, {
    role: role.name,
    prompt,
    parentSessionKey: ctx.parentSessionKey,
    access,
    label: typeof args.label === 'string' ? args.label : undefined,
  });

  const childKey = childSessionKey(ctx.parentSessionKey, record.id);
  const seededIds: string[] = Array.isArray(args.seedRecordIds)
    ? args.seedRecordIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 20)
    : [];
  const basePrompt = buildSystemPrompt({
    workspaceRoot: ctx.workspaceRoot,
    launchCwd: ctx.launchCwd,
    sessionKey: childKey,
    instructionSummary: loadWorkspaceInstructionSummary(ctx.workspaceRoot),
  });
  let systemPromptOverride = buildRolePrompt(role, basePrompt, '');
  if (seededIds.length > 0) {
    systemPromptOverride +=
      `\n\n## Parent-recalled BrainRouter records\n` +
      `The parent agent already recalled these memory record IDs: ${seededIds.join(', ')}. ` +
      `Call memory_recall (or memory_search) with the same intent before doing duplicate exploration, and prefer building on these records over re-deriving them.`;
  }

  const childAgent = new Agent(ctx.mcpClient, ctx.llmConfig, {
    workspaceRoot: ctx.workspaceRoot,
    launchCwd: ctx.launchCwd,
    sessionKey: childKey,
    roleOverlay: role.promptOverlay,
    accessMode: access,
    silent: true,
    systemPromptOverride,
  });

  updateSession(ctx.workspaceRoot, record.id, { status: 'running' });

  const promise = (async () => {
    try {
      const output = await childAgent.runTurn(prompt, {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      });

      // Working-memory offload: when a child returns a sizeable payload, push
      // the full body into the BrainRouter working canvas and keep only a
      // pointer in the session record. This is the main context-saving win
      // for parents synthesizing multiple child outputs.
      let storedOutput = output;
      let workingRef: string | undefined;
      if (output && output.length >= OFFLOAD_THRESHOLD_CHARS) {
        workingRef = await offloadChildOutput(ctx, record.id, role.name, prompt, output);
        if (workingRef) {
          storedOutput =
            `[offloaded to working memory ref=${workingRef}]\n` +
            `Preview (${OFFLOAD_PREVIEW_CHARS} chars of ${output.length}):\n` +
            output.slice(0, OFFLOAD_PREVIEW_CHARS);
        }
      }

      updateSession(ctx.workspaceRoot, record.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        finalOutput: storedOutput,
      });
    } catch (err: any) {
      updateSession(ctx.workspaceRoot, record.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err?.message ?? String(err),
      });
    } finally {
      runningPromises.delete(record.id);
    }
  })();
  runningPromises.set(record.id, promise);

  if (args.wait) {
    return await handleWait({ id: record.id, timeoutMs: args.timeoutMs ?? 120000 }, ctx);
  }
  return JSON.stringify({ id: record.id, role: role.name, access, status: 'running' }, null, 2);
}

function handleList(ctx: OrchestrationContext): string {
  const sessions = listSessions(ctx.workspaceRoot);
  return JSON.stringify(sessions.map(s => summarize(s)), null, 2);
}

async function handleWait(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '');
  if (!id) throw new Error('wait_agent requires an id.');
  const timeoutMs = Number(args.timeoutMs ?? 120000);

  const promise = runningPromises.get(id);
  if (promise) {
    let timedOut = false;
    await Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)),
    ]);
    if (timedOut) {
      return JSON.stringify({ id, status: 'timeout' }, null, 2);
    }
  }

  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  return JSON.stringify(summarize(record, true), null, 2);
}

function handleReadTranscript(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const limit = Number(args.limit ?? 40);
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  const childKey = childSessionKey(record.parentSessionKey, record.id);
  const entries = readTranscriptEntries(ctx.workspaceRoot, childKey, limit);
  return JSON.stringify({ id, entries }, null, 2);
}

function handleClose(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  const next = updateSession(ctx.workspaceRoot, id, { status: 'closed', completedAt: new Date().toISOString() });
  return JSON.stringify(summarize(next, true), null, 2);
}

async function offloadChildOutput(
  ctx: OrchestrationContext,
  childId: string,
  role: string,
  prompt: string,
  output: string,
): Promise<string | undefined> {
  const res = await callMcpTool<any>(ctx.mcpClient, 'memory_working_offload', {
    sessionKey: childSessionKey(ctx.parentSessionKey, childId),
    workspacePath: ctx.workspaceRoot,
    payload: output,
    title: `Child ${childId} (${role}) output`,
    summary: prompt.slice(0, 240),
    kind: `child-agent-${role}`,
  });
  if (res.isError) return undefined;
  return res.parsed?.refNodeId ?? res.parsed?.nodeId ?? res.parsed?.ref ?? undefined;
}

function summarize(record: ChildSessionRecord, includeOutput = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    role: record.role,
    status: record.status,
    access: record.access,
    label: record.label,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    summary: formatSessionSummary(record),
  };
  if (includeOutput) {
    if (record.finalOutput) base.finalOutput = record.finalOutput;
    if (record.error) base.error = record.error;
  }
  return base;
}
