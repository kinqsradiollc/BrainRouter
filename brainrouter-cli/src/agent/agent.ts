import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
// 0.3.7 — Agent now talks to a Pool of MCP servers. The Pool's public
// surface matches McpClientWrapper's (listTools / callTool / isConnected /
// getIdentity / getServerName / close), so existing call sites stay
// unchanged. Single-server setups become a degenerate pool of one.
import type { McpClientPool as McpClientWrapper } from '../runtime/mcpPool.js';
import { askChoice, askYesNo, getActiveReadline, NoTTYError } from '../cli/cliPrompt.js';
import type { LLMConfig } from '../config/config.js';
import { appendTranscriptEntry, redactText } from '../state/sessionStore.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../prompt/systemPrompt.js';
import { formatPlan, readPlan, updatePlan } from '../state/taskStore.js';
import type { AccessMode } from '../orchestration/roles.js';
import {
  createTaskAgentTool,
  createDelegateAgentTool,
  createSpawnAgentTool,
  createSpawnAgentsTool,
  createListAgentsTool,
  createWaitAgentTool,
  createWaitAgentsTool,
  createReadAgentTranscriptTool,
  createCloseAgentTool,
  createRouteAgentTool,
  executeOrchestrationTool,
  isOrchestrationToolName,
  type OrchestrationContext,
} from '../orchestration/tools.js';
import { getSession } from '../orchestration/orchestrator.js';
import { buildDefaultSourcePlan, buildMemoryBriefing, describeSourcePlan, selectCitedRecordIds, type RecalledRecord } from '../memory/briefing.js';
import {
  countEntityTokens as countEntityTokensFromText,
  decideMemoryBriefing,
  resolveRecallMode as resolveRecallModeFromEnv,
  type BriefingDecision,
} from '../memory/briefingTriggers.js';
import { callMcpTool, extractToolText } from '../runtime/mcpUtils.js';
import { acquireLLMSlot } from '../runtime/llmSemaphore.js';
import { blockGoal, completeGoal, formatGoalBlock, readGoal } from '../state/goalStore.js';
import { runHooks } from '../state/hooksStore.js';
import { resolveSandboxConfig, runShell } from '../runtime/sandbox.js';
import { isDangerousCommand, resolveRunCommandApproval } from '../runtime/dangerousCommand.js';
import { readPreferences, resolveEffort, type EffortLevel } from '../state/preferencesStore.js';
import { shouldUseAnthropicNative, callAnthropic } from '../runtime/anthropicAdapter.js';
import { startSpan, traceEvent } from '../runtime/tracing.js';
import { buildHookifyContext, evaluateHookify, listHookifyRules } from '../state/hookifyStore.js';
import { renderCompactSystemMessage, runCompaction } from '../prompt/compactor.js';
import { compactToolOutput } from '../prompt/toolCompaction.js';
import { buildFanOutHint, shouldSuggestFanOut } from '../prompt/breadthHint.js';
import { isParallelSafe, parallelExecutionEnabled } from './toolSafety.js';
import {
  dedupeToolCalls,
  parseArgumentsOrError,
  synthesizeOrphanResults,
  suggestSimilarToolName,
} from './toolCallRecovery.js';

const execPromise = promisify(exec);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.DS_Store', '.next']);
const DEFAULT_CHILD_DRAIN_TIMEOUT_MS = 30_000;

function parseJsonObject(text: string): any | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectChildIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const ids: string[] = [];
  const maybeRecord = value as Record<string, unknown>;
  if (typeof maybeRecord.id === 'string') ids.push(maybeRecord.id);
  if (Array.isArray(maybeRecord.agents)) {
    for (const entry of maybeRecord.agents) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string') {
        ids.push((entry as Record<string, unknown>).id as string);
      }
    }
  }
  return [...new Set(ids)];
}

function trackChildObservation(
  toolName: string,
  args: any,
  resultText: string,
  spawned: Set<string>,
  waited: Set<string>,
): void {
  if (
    toolName === 'spawn_agent' ||
    toolName === 'spawn_agents' ||
    toolName === 'task_agent' ||
    toolName === 'delegate_agent'
  ) {
    const ids = collectChildIds(parseJsonObject(resultText));
    for (const id of ids) {
      spawned.add(id);
      // task_agent always blocks internally (wraps spawn with wait: true);
      // spawn_agent({ wait: true }) is the legacy form. Both count as
      // already-observed, so the child-drain guardrail doesn't double-wait.
      // delegate_agent is fire-and-forget — must remain unwaited so the
      // guardrail can force a wait_agents call before the parent answers.
      if (toolName === 'task_agent') waited.add(id);
      else if (toolName === 'spawn_agent' && args?.wait) waited.add(id);
    }
    return;
  }

  if (toolName === 'wait_agent') {
    const id = typeof args?.id === 'string' ? args.id : undefined;
    if (id) waited.add(id);
    return;
  }

  if (toolName === 'wait_agents') {
    const ids = Array.isArray(args?.ids) ? args.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    for (const id of ids) waited.add(id);
  }
}

function parseChildDrainTimeouts(resultText: string): Array<{ id: string; role?: string; status: string; childStatus?: string; summary?: string }> {
  const parsed = parseJsonObject(resultText);
  const agents: unknown[] = Array.isArray(parsed?.agents) ? parsed.agents : [];
  return agents
    .filter((entry: unknown): entry is Record<string, unknown> => {
      return !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'timeout';
    })
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '(unknown)',
      role: typeof entry.role === 'string' ? entry.role : undefined,
      status: 'timeout',
      childStatus: typeof entry.childStatus === 'string' ? entry.childStatus : undefined,
      summary: typeof entry.summary === 'string' ? entry.summary : undefined,
    }));
}

function formatChildDrainTimeoutAnswer(timeouts: Array<{ id: string; role?: string; childStatus?: string; summary?: string }>): string {
  const lines = [
    `Children still running after the bounded wait (${timeouts.length}):`,
    ...timeouts.map((child) => {
      const role = child.role ? ` role=${child.role}` : '';
      const status = child.childStatus ? ` status=${child.childStatus}` : '';
      const summary = child.summary ? ` — ${child.summary}` : '';
      return `- ${child.id}${role}${status}${summary}`;
    }),
    '',
    'Use `/continue` to drain the pending child output and synthesize the result when it is ready.',
  ];
  return lines.join('\n');
}

export interface RunTurnCallbacks {
  onStatusUpdate: (status: string) => void;
  onToolStart: (name: string, args: Record<string, any>) => void;
  onToolEnd: (name: string, result: { success: boolean; summary: string; preview?: string }) => void;
  /**
   * Optional: invoked whenever the agent calls update_plan during a turn,
   * so the REPL can render a live ✓ / ⏳ / ☐ checklist instead of leaving the
   * plan invisible until the user runs `/plan`.
   */
  onPlanUpdate?: (items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>, explanation?: string) => void;
  /**
   * Optional: invoked when a child agent (spawn_agent) finishes its runTurn —
   * either succeeded with a final answer (preview supplied) or failed (error
   * supplied). Lets the REPL signal "Agent X is done" so the user isn't
   * staring at silence after the tool stream stops.
   */
  onChildComplete?: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }) => void;
  /**
   * Optional: paired live child tool events surfaced from spawn_agent
   * children up to the parent REPL. Lets the UI render explicit
   * "child began Read(...)" / "child finished — 1.2s" rows in scrollback
   * so long child runs no longer look like the parent has paused
   * (roadmap §3 child progress visibility).
   */
  onChildToolStart?: (event: { childId: string; role: string; tool: string; args: Record<string, any> }) => void;
  onChildToolEnd?: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }) => void;
  /**
   * Optional: invoked when the agent's automatic memory pipeline runs —
   * pre-turn briefing, post-turn capture, citation marking. Surfacing these
   * tells the user the BrainRouter cognitive memory engine is active even
   * though those MCP calls are hidden from the LLM's tool stream.
   */
  onMemoryEvent?: (event: MemoryEvent) => void;
}

export type MemoryEvent =
  | { kind: 'briefing'; sources: string[]; recordCount: number }
  | {
      kind: 'capture';
      sessionKey: string;
      messageCount: number;
      /** Number of sensory rows the MCP server wrote (raw conversation log). */
      sensoryRecorded?: number;
      /** True iff cognitive extraction was attempted this turn (may still have failed). */
      extractionTriggered?: boolean;
      /** Number of cognitive records produced — 0 indicates extraction is silently broken. */
      extractedCount?: number;
      /** Set when the extractor reports it couldn't reach the LLM. */
      extractionWarning?: string;
    }
  | { kind: 'citation'; recordIds: string[] }
  | { kind: 'contradiction'; warning: string }
  | { kind: 'skipped'; reason: string };

export interface LastBriefingDetails {
  decision: BriefingDecision['action'] | 'none';
  reasons: string[];
  sources: string[];
  sourcesPlanned: string[];
  skippedSources: Array<{ source: string; reason: string }>;
  sourceStats: Array<{ source: string; chars: number; records: number }>;
  recordIds: string[];
  recordCount: number;
  tokensInjected: number;
  charsSaved: number;
  warnings: string[];
}

export interface ChatCompletionPayload {
  model: string;
  messages: any[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
  tool_choice?: 'auto';
  /**
   * OpenAI Chat Completions reasoning slot — accepted by gpt-5 / o-series.
   * Only set when the user has chosen a non-default `/effort` AND the
   * endpoint+model combo accepts the field (see `supportsReasoningEffortField`).
   */
  reasoning_effort?: EffortLevel;
}

export interface AgentOptions {
  workspaceRoot: string;
  launchCwd: string;
  sessionKey?: string;
  roleOverlay?: string;
  accessMode?: AccessMode;
  silent?: boolean;
  systemPromptOverride?: string;
  /** When true (default for silent children: false), pre-turn memory recall runs even in silent mode. */
  enableRecall?: boolean;
  /**
   * Parent OTEL trace context. Set by `spawn_agent` so the child's per-turn
   * spans nest under the parent's `brainrouter.turn` span. Without this each
   * child started a fresh trace tree and fan-out runs flattened in trace
   * viewers — you couldn't see "this child belongs to that parent turn".
   */
  parentTraceId?: string;
  parentSpanId?: string;
  /** Agent tier — propagated from the definition so hierarchy checks work in grandchildren. */
  tier?: 'chat' | 'reasoning' | 'worker';
  /** Nesting depth in the spawn chain; 0 = direct child of the chat root (default). */
  agentDepth?: number;
}

export const LOCAL_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the workspace. Optional line ranges can be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
        startLine: { type: 'integer', description: 'Optional 1-based start line number to read from.' },
        endLine: { type: 'integer', description: 'Optional 1-based end line number to read to.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
        content: { type: 'string', description: 'The full content to write to the file.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Edit an existing file in the workspace by replacing a target substring with a replacement string.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
        targetContent: { type: 'string', description: 'The exact substring in the file to be replaced.' },
        replacementContent: { type: 'string', description: 'The replacement string.' }
      },
      required: ['path', 'targetContent', 'replacementContent']
    }
  },
  {
    name: 'list_dir',
    description: 'List the contents of a directory in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory, relative to workspace root. Defaults to "."' }
      }
    }
  },
  {
    name: 'grep_search',
    description: 'Search for a query string in files within a directory in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to search under. Defaults to "."' },
        query: { type: 'string', description: 'String or regex query pattern to search for.' }
      },
      required: ['query']
    }
  },
  {
    name: 'glob_files',
    description: 'Recursively find files in the workspace matching a glob/wildcard pattern (e.g., "src/**/*.ts" or "*.json").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob or wildcard pattern to search for.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command on the user\'s terminal. Requires user approval before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' }
      },
      required: ['command']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch the text content of a URL from the internet (e.g. documentation, api references, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute HTTP or HTTPS URL to fetch.' }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description: 'Search the public web for a query and return top results (title, url, snippet). Useful when fetch_url needs a starting point.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: { type: 'integer', description: 'Maximum results to return. Default 5, max 10.' }
      },
      required: ['query']
    }
  },
  {
    name: 'apply_patch',
    description: 'Apply a multi-file patch using the Begin/End envelope format ("*** Begin Patch / *** Update File: path / @@ context / -old / +new / *** Add File: / *** Delete File: / *** End Patch"). Lets you make several coordinated edits across files in one tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'The full patch text including Begin Patch/End Patch envelope.' }
      },
      required: ['patch']
    }
  },
  createTaskAgentTool(),
  createDelegateAgentTool(),
  createSpawnAgentTool(),
  createSpawnAgentsTool(),
  createListAgentsTool(),
  createWaitAgentTool(),
  createWaitAgentsTool(),
  createReadAgentTranscriptTool(),
  createCloseAgentTool(),
  createRouteAgentTool(),
  {
    name: 'ask_user_choice',
    description:
      'Pause the turn and ask the human to commit to ONE of 2–4 mutually exclusive approaches. ' +
      'Renders an arrow-key picker (↑/↓ navigate, ENTER confirm; SPACE toggles in multiSelect mode) ' +
      'with an always-on "Other" row that drops to a free-text prompt — the user is never trapped between bad options. ' +
      'Returns { answer: <chosen label or free-text> } in single-select, or { answer: [labels/free-text…] } in multiSelect. ' +
      'Use ONLY when there is genuine ambiguity that needs the user\'s judgment — NOT for trivial yes/no confirmations ' +
      '(`askYesNo` is wired into approval gates already), NOT for things you can decide yourself with the available context, ' +
      'and NOT as a substitute for thinking. ' +
      'Errors in non-interactive runs (CI / piped / `brainrouter run`) and when the user cancels (Esc/q/Ctrl+C); ' +
      'on either error, decide yourself and say which option you picked and why.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user (complete sentence ending with `?`).' },
        header: { type: 'string', description: 'Short chip-style label (≤12 chars) shown above the question, e.g. "Auth method" or "Storage".' },
        options: {
          type: 'array',
          description: '2–4 mutually exclusive choices. Each option needs a short label and a one-line description.',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short display text (1–5 words).' },
              description: { type: 'string', description: 'One-line explanation of what this option means or what will happen if chosen.' },
            },
            required: ['label', 'description'],
          },
        },
        multiSelect: { type: 'boolean', description: 'When true, allow the user to pick multiple options (comma-separated input). Defaults to false.' },
      },
      required: ['question', 'header', 'options'],
    },
  },
  {
    name: 'update_plan',
    description: 'Create or update the durable CLI task plan. Use this for multi-step work and keep at most one item in_progress.',
    inputSchema: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Optional short explanation of the plan update.' },
        plan: {
          type: 'array',
          description: 'Ordered plan items.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
            },
            required: ['step', 'status']
          }
        }
      },
      required: ['plan']
    }
  },
  {
    name: 'goal_complete',
    description:
      'Mark the active /goal complete. CALL ONLY when concrete evidence in the thread (tests passing, file written, benchmark hit, artifact produced) proves the outcome is satisfied. Pass a 1–2 sentence proof citing the evidence. PRECONDITION: if you have an active plan (from update_plan), every item must be marked `completed` before this call succeeds — call update_plan first to mark finished work done (or mark intentionally-dropped items completed with a rationale). The CLI hard-refuses goal_complete while pending / in_progress items remain. CRITICAL: in the SAME assistant message as this tool call, ALSO write the user-visible deliverable as prose — the actual answer, analysis, summary, or report the user asked for. The `proof` field is short audit metadata (file paths, test names, command exit codes), NOT the deliverable. If you skip the prose, the user sees only a placeholder and your work is invisible to them.',
    inputSchema: {
      type: 'object',
      properties: {
        proof: { type: 'string', description: 'Short evidence-based justification (file path / test name / output). Audit metadata only — NOT the user-visible answer; put that in the assistant message text.' },
      },
      required: ['proof'],
    },
  },
  {
    name: 'goal_blocked',
    description:
      'Mark the active /goal blocked. CALL when no defensible path remains within boundaries (missing data, ambiguous spec, external dependency). Pass a reason and what user input would unblock it. CRITICAL: in the SAME assistant message as this tool call, ALSO write the user-visible explanation as prose — what you tried, what you learned, why you stopped, what the user needs to do next. The `reason` / `needed` fields are short audit metadata, NOT the deliverable.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason progress stalled. Audit metadata only — write the full explanation in the assistant message text.' },
        needed: { type: 'string', description: 'What user input or external resource would unblock progress.' },
      },
      required: ['reason'],
    },
  }
];

/**
 * @deprecated Prefer passing an explicit workspaceRoot. Returns process.cwd()
 * which is brittle when the Agent was constructed with a workspace different
 * from cwd (e.g. when /resume re-attaches a session originally captured in
 * another dir, or when the user cd's away after launch).
 */
export function getWorkspaceRoot(): string {
  return fs.realpathSync(process.cwd());
}

/**
 * Best-effort guidance for the LLM when it calls a tool name that doesn't
 * exist (JSON-RPC -32601). The most common cause is confusing a BrainRouter
 * skill (documentation) for an invocable tool. Pattern-match on the name and
 * return a corrective hint that the next agent turn will see as the tool
 * result.
 */
export function explainUnknownToolName(name: string): string {
  const trimmed = (name ?? '').trim();
  const lower = trimmed.toLowerCase();
  const looksLikeSkill =
    lower.endsWith('-skill') ||
    /(implementation|workflow|driven|generator|recovery|cleanup|simplification)$/i.test(lower) ||
    /skill$/i.test(lower);
  if (looksLikeSkill) {
    return (
      'It looks like you tried to invoke a SKILL as if it were a tool. ' +
      'Skills are markdown documentation packages, not invocable functions. ' +
      'To use one: call `list_skills({ scope: "all" })` to find the canonical name, ' +
      `then \`get_skill({ name: "${trimmed}" })\` (or the closest match) to load its instructions, ` +
      'and then follow the steps yourself with the regular tools (read_file, write_file, run_command, spawn_agent, …).'
    );
  }
  return (
    'Verify the tool name by inspecting the tool list that was attached at turn start. ' +
    'If you intended a skill (documentation/workflow), load it via `get_skill` first; ' +
    'skills are not directly callable.'
  );
}

/**
 * Cross-vendor tool-name aliases. Models trained on Claude Code's tool
 * vocabulary often emit `Bash` / `bash` when they want to run a shell command;
 * BrainRouter's canonical name is `run_command`. Rather than rename the tool
 * (breaking transcripts and prompts), normalize the alias at dispatch time.
 *
 * Keep this list short: every alias is a hint the LLM doesn't read its own
 * tool list before calling. Aliases for read_file / write_file / etc. could
 * follow if observed empirically.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: 'run_command',
  shell: 'run_command',
  sh: 'run_command',
};

/**
 * Normalize a tool name the LLM emitted into the canonical form used by the
 * tool registry. Handles common variants: case (`Read_File`), separators
 * (`read-file`, `read.file`), surrounding whitespace, and a short list of
 * cross-vendor aliases (`Bash` → `run_command`).
 *
 * Returns the exact canonical name if a unique match is found among the
 * provided candidates; otherwise returns the trimmed input (so the regular
 * dispatch/explainUnknownToolName path still runs).
 */
export function normalizeToolName(raw: string, candidates: string[]): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  // Exact match short-circuits — keeps the hot path cheap.
  if (candidates.includes(trimmed)) return trimmed;
  const flatten = (s: string) => s.toLowerCase().replace(/[-.\s_]+/g, '');
  const target = flatten(trimmed);
  // Cross-vendor alias resolution: check before generic case/separator
  // matching so `Bash` resolves to `run_command` even though the flattened
  // forms differ. Only honored when the canonical target is actually
  // registered — keeps us from silently rerouting in unexpected configs.
  const aliased = TOOL_NAME_ALIASES[target];
  if (aliased && candidates.includes(aliased)) return aliased;
  const matches = candidates.filter((c) => flatten(c) === target);
  if (matches.length === 1) return matches[0];
  return trimmed;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a workspace-relative path against the given workspaceRoot. Throws
 * if the result escapes the workspace.
 *
 * `workspaceRoot` is REQUIRED — passing a stale `process.cwd()` was the bug
 * that let tool writes land in `~/.brainrouter` when the user's cwd drifted.
 *
 * For backwards compatibility, the workspaceRoot parameter may be omitted; it
 * then falls back to process.cwd(). New code should always pass it explicitly.
 */
export function resolveWorkspacePath(
  workspaceRootOrPath: string = '.',
  inputPathOrOptions?: string | { forWrite?: boolean },
  maybeOptions?: { forWrite?: boolean },
): string {
  // Two call shapes are supported during the migration of callers:
  //   resolveWorkspacePath(workspaceRoot, inputPath, options)
  //   resolveWorkspacePath(inputPath, options)   ← deprecated; falls back to cwd
  let workspaceRoot: string;
  let inputPath: string;
  let options: { forWrite?: boolean };
  if (typeof inputPathOrOptions === 'string') {
    workspaceRoot = workspaceRootOrPath;
    inputPath = inputPathOrOptions;
    options = maybeOptions ?? {};
  } else {
    workspaceRoot = fs.realpathSync(process.cwd());
    inputPath = workspaceRootOrPath;
    options = inputPathOrOptions ?? {};
  }

  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('Path must be a non-empty string.');
  }

  const root = fs.realpathSync(workspaceRoot);
  const resolved = path.resolve(root, inputPath);
  const checkPath = options.forWrite ? path.dirname(resolved) : resolved;
  const existingCheckPath = fs.existsSync(checkPath) ? fs.realpathSync(checkPath) : checkPath;

  if (!isPathInside(root, existingCheckPath) || !isPathInside(root, resolved)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }

  return resolved;
}

export class Agent {
  private mcpClient: McpClientWrapper;
  private llmConfig: LLMConfig;
  public sessionKey: string;
  public workspaceRoot: string;
  public launchCwd: string;
  private chatHistory: any[] = [];
  private initialized = false;
  private recalledRecordIds: string[] = [];
  private recalledRecords: RecalledRecord[] = [];
  private lastBriefingSources: string[] = [];
  private lastBriefingDetails: LastBriefingDetails = {
    decision: 'none',
    reasons: [],
    sources: [],
    sourcesPlanned: [],
    skippedSources: [],
    sourceStats: [],
    recordIds: [],
    recordCount: 0,
    tokensInjected: 0,
    charsSaved: 0,
    warnings: [],
  };
  /**
   * 10b: latest MCP tool inventory captured by `listTools()` calls. Used by
   * `createSystemMessage` to decide whether the BrainRouter memory section
   * should render — when `memory_recall` is missing from this list (the
   * cloud brain is offline), the prompt swaps to a brain-offline notice so
   * the model doesn't try to call tools that aren't there. Undefined until
   * the first successful list; treated as "assume online" by the prompt
   * builder until then (back-compat for callers that don't list pre-turn).
   */
  private lastKnownMcpTools?: Array<{ name: string }>;
  /**
   * 9b: gated recall state. `recallHasFiredThisSession` flips to true on the
   * first successful briefing injection so subsequent turns can skip the
   * fresh recall pull unless a gated trigger fires. `recallNextTurnIsPost-
   * Compaction` is set by `compactHistory()` to force the next turn through
   * the full briefing path (compaction just dropped the prior briefing as
   * collateral; replay it once so the model isn't blind). Both are
   * cleared on `loadHistory` / `fork` / `bootstrapSession` so a fresh
   * session re-pulls.
   */
  private recallHasFiredThisSession = false;
  private recallNextTurnIsPostCompaction = false;
  private turnsSinceLastFullBriefing = 0;
  private recentToolFailure?: string;
  private roleOverlay?: string;
  private accessMode: AccessMode;
  private silent: boolean;
  private enableRecall: boolean;
  private systemPromptOverride?: string;
  /**
   * Name of the BrainRouter skill currently being executed (e.g. via `/skill`
   * or implicit memetic activation). Threaded into `memory_recall` and
   * `memory_capture_turn` so skill-scoped recall boost, neural-spark
   * prewarming, and per-record `skill_tag` extraction all fire correctly.
   * Null/undefined when no skill is active.
   */
  public activeSkill?: string;
  /**
   * Parent trace context (set by spawn_agent for child agents). When present,
   * the per-turn span uses these as its trace/parent so OTEL viewers can
   * stitch the fan-out tree together. Top-level (REPL) agents leave these
   * undefined and get a fresh trace per turn.
   */
  private parentTraceId?: string;
  private parentSpanId?: string;
  /**
   * Synthetic agent id used in OTEL attributes so child spans can be grouped
   * even without trace links. Equals `agent-<6 random hex>` per Agent
   * instance. Surfaced as the `agent_id` / `parent_agent_id` span attrs.
   */
  public readonly agentId: string = `agent-${Math.random().toString(36).slice(2, 8)}`;
  /** agent_id of the parent (set by spawn_agent for children). */
  private parentAgentId?: string;
  /** Agent tier — forwarded to OrchestrationContext so grandchildren can inherit hierarchy checks. */
  public readonly tier?: 'chat' | 'reasoning' | 'worker';
  /** Spawn-chain depth (0 = direct chat-root child). Forwarded to hierarchy checks. */
  public readonly agentDepth: number;

  constructor(mcpClient: McpClientWrapper, llmConfig: LLMConfig, options: AgentOptions) {
    this.mcpClient = mcpClient;
    this.llmConfig = llmConfig;
    this.workspaceRoot = options.workspaceRoot;
    this.launchCwd = options.launchCwd;
    // Each CLI process gets a fresh sessionKey by default. The previous
    // workspace-derived fallback (`brainrouter-cli:<workspaceRoot>`) made
    // MCP's `memory_resolve_session` fall into its workspace-cache branch
    // and return the same UUID for every CLI in the workspace, so two
    // concurrent CLIs shared one goal/plan/working bucket. A randomUUID
    // here is accepted by MCP's `isUniqueId` and echoed back as-is, so
    // each CLI is its own session for local state. The memory DB is
    // userId-scoped, so cross-CLI recall continuity is unaffected.
    this.sessionKey = options.sessionKey ?? randomUUID();
    this.roleOverlay = options.roleOverlay;
    this.accessMode = options.accessMode ?? 'shell';
    this.silent = options.silent ?? false;
    // Children default to no recall (their seed context already covers the parent's recall).
    // Parents (non-silent) always recall.
    this.enableRecall = options.enableRecall ?? !this.silent;
    this.systemPromptOverride = options.systemPromptOverride;
    this.parentTraceId = options.parentTraceId;
    this.parentSpanId = options.parentSpanId;
    this.tier = options.tier;
    this.agentDepth = options.agentDepth ?? 0;
  }

  /** Expose for orchestration so spawn_agent can record the parent linkage. */
  public getAgentId(): string {
    return this.agentId;
  }
  /** Internal — used by spawn_agent to record which parent dispatched us. */
  public setParentAgentId(id: string | undefined): void {
    this.parentAgentId = id;
  }

  private isModelVisibleMcpTool(tool: any): boolean {
    const hiddenBrainrouterTools = new Set([
      'memory_capture_turn',
      'memory_mark_cited',
      'memory_resolve_session',
      'memory_register_skill_hints',
      'memory_hook_register',
      'memory_hook_status',
    ]);
    const name = String(tool?.name ?? '');
    const rawName = String(tool?.__rawName ?? this.rawMcpToolName(name));
    if (!hiddenBrainrouterTools.has(rawName)) return true;

    const serverId = typeof tool?.__serverId === 'string'
      ? tool.__serverId
      : this.serverIdFromMcpToolName(name);
    const status = serverId && typeof (this.mcpClient as any).getStatus === 'function'
      ? (this.mcpClient as any).getStatus(serverId)
      : undefined;
    // Hide only BrainRouter auto-pipeline/admin tools. Third-party MCP tools
    // with coincidentally similar names stay visible.
    return status?.identity !== 'brainrouter';
  }

  private rawMcpToolName(name: string): string {
    const serverId = this.serverIdFromMcpToolName(name);
    return serverId ? name.slice(`mcp_${serverId}_`.length) : name;
  }

  private serverIdFromMcpToolName(name: string): string | undefined {
    // Canonical single-underscore prefix: `mcp_<server>_<tool>`. The pool
    // normalises to this shape at its boundary (0.3.8-R5).
    if (!name.startsWith('mcp_')) return undefined;
    const rest = name.slice('mcp_'.length);
    if (typeof (this.mcpClient as any).getServerIds === 'function') {
      const ids = (this.mcpClient as any).getServerIds() as string[];
      for (const id of ids.sort((a, b) => b.length - a.length)) {
        if (rest.startsWith(`${id}_`)) return id;
      }
    }
    const idx = rest.indexOf('_');
    return idx >= 0 ? rest.slice(0, idx) : undefined;
  }

  private allowedToolsForAccess(): Set<string> {
    // Lifecycle / inspection tools are always available regardless of access
    // mode — they don't touch the workspace and the agent needs them to end
    // a goal cleanly (goal_complete / goal_blocked) or observe state.
    const readOnly = new Set([
      'read_file', 'list_dir', 'grep_search', 'glob_files', 'fetch_url', 'web_search', 'update_plan',
      'task_agent', 'delegate_agent', 'spawn_agent', 'spawn_agents', 'list_agents', 'wait_agent', 'wait_agents',
      'read_agent_transcript', 'close_agent', 'route_agent',
      'goal_complete', 'goal_blocked',
      // ask_user_choice doesn't touch the workspace — it's an interaction
      // primitive, so it stays available in every access mode (and is gated
      // structurally by activeReadline / isTTY in the helper itself).
      'ask_user_choice',
    ]);
    const writeAdds = new Set(['write_file', 'edit_file', 'apply_patch']);
    const shellAdds = new Set(['run_command']);
    if (this.accessMode === 'read') return readOnly;
    if (this.accessMode === 'write') return new Set([...readOnly, ...writeAdds]);
    return new Set([...readOnly, ...writeAdds, ...shellAdds]);
  }

  async runTurn(prompt: string, callbacks: RunTurnCallbacks): Promise<string> {
    if (!this.initialized) {
      await this.bootstrapSession(callbacks);
    }
    this.lastTurnUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
    this.lastTurnToolCalls = 0;
    this.lastGoalTransition = undefined;
    // OTEL-style span: one trace per turn, tool calls become child spans.
    // When this Agent was spawned as a child, inherit the parent's traceId
    // + spanId so fan-out runs stitch into one tree across processes (or
    // promises). Top-level REPL agents get a fresh trace per turn.
    const turnSpan = startSpan('brainrouter.turn', {
      session_key: this.sessionKey,
      access_mode: this.accessMode,
      model: this.llmConfig.model,
      role_overlay: this.roleOverlay ? 'set' : 'none',
      agent_id: this.agentId,
      parent_agent_id: this.parentAgentId,
    }, {
      traceId: this.parentTraceId,
      parentSpanId: this.parentSpanId,
    });

    callbacks.onStatusUpdate('Loading available tools...');
    let mcpTools: any[] = [];
    try {
      const toolsRes = await this.mcpClient.listTools();
      mcpTools = toolsRes.tools || [];
    } catch (err: any) {
      // Non-fatal: continue with local tools only
    }
    // 10b: cache the inventory so `createSystemMessage` can render a
    // brain-online vs brain-offline prompt. Refresh chatHistory[0]
    // whenever the inventory shape changed (online → offline or vice
    // versa) so the next LLM call sees the correct system message.
    const prevTools = this.lastKnownMcpTools?.map((t) => t.name).sort().join(',');
    this.lastKnownMcpTools = mcpTools.map((t: any) => ({
      name: String(t?.__rawName ?? this.rawMcpToolName(String(t?.name ?? ''))),
    }));
    const newTools = this.lastKnownMcpTools.map((t) => t.name).sort().join(',');
    if (prevTools !== newTools && this.chatHistory.length > 0 && this.chatHistory[0].role === 'system') {
      this.chatHistory[0] = this.createSystemMessage();
    }

    const allowed = this.allowedToolsForAccess();
    const filteredLocalTools = LOCAL_TOOLS.filter(t => allowed.has(t.name));
    // Multi-MCP parity: expose every connected third-party MCP tool and the
    // model-safe BrainRouter MCP tools in one turn, using the pool's
    // `mcp_<serverId>_<tool>` namespaces. BrainRouter's auto-pipeline/admin
    // tools stay hidden because the CLI owns those flows.
    const visibleMcpTools = mcpTools.filter((t: any) => this.isModelVisibleMcpTool(t));
    const allTools = [...filteredLocalTools, ...visibleMcpTools];
    callbacks.onStatusUpdate(`Loaded ${filteredLocalTools.length} local tools and ${mcpTools.length} MCP tools.`);

    // Auto-compact: if the chat history has grown past the configured token
    // budget, summarize before this turn starts. Otherwise the model sees
    // ever-growing context (briefings, tool outputs, prior turns) and the
    // request balloons until the endpoint rejects it. Default threshold is
    // generous; users can lower BRAINROUTER_AUTO_COMPACT_TOKENS to ~30000
    // for cost-sensitive models.
    if (!this.silent) {
      const autoCompactThreshold = Number(process.env.BRAINROUTER_AUTO_COMPACT_TOKENS) || 80_000;
      const estimated = Agent.estimateTokens(JSON.stringify(this.chatHistory));
      if (estimated > autoCompactThreshold && this.chatHistory.length > 6) {
        callbacks.onStatusUpdate(`Auto-compacting history (~${estimated} tokens > ${autoCompactThreshold})...`);
        try {
          await this.compactHistory();
        } catch {
          // If compaction fails (no LLM, network), continue without it — better
          // a big payload than a hard turn failure.
        }
      }
    }

    await this.injectRecallContext(prompt, mcpTools, callbacks);

    // Lifecycle: pre-turn hook (informational; failures don't abort the turn).
    if (!this.silent) runHooks(this.workspaceRoot, 'pre-turn', { payload: { prompt } });

    this.lastUserPrompt = prompt;
    this.lastTurnHitLoopLimit = false;
    // Breadth-intent detection: when the user signals "do everything" / "in 1 go"
    // / "thoroughly" / "as much as possible", inject a fan-out hint so the
    // agent reaches for spawn_agents instead of a single sequential tool call.
    // Skipped for child agents (silent) — they've already been narrowed by
    // their parent.
    if (!this.silent) {
      const { suggest, intent } = shouldSuggestFanOut(prompt);
      if (suggest) {
        this.replaceTaggedSystemMessage('fanout-hint', buildFanOutHint(prompt, intent));
        callbacks.onStatusUpdate(`Fan-out hint injected (signals: ${intent.signals.join(', ')})`);
        // Mirror onMemoryEvent's shape so REPL has one render path — but use
        // onToolStart since it goes through the safePrint pipeline that the
        // user already sees. Tag as a virtual tool so it's obvious.
        callbacks.onToolStart('breadth-detector', { signals: intent.signals, score: intent.score });
        callbacks.onToolEnd('breadth-detector', { success: true, summary: `fan-out hint injected (${intent.signals.length} signals)` });
      }
    }

    // Per-turn goal anchor: re-inject a FRESH goal block at the end of the
    // chatHistory's system messages (replaceTaggedSystemMessage appends), so
    // it lands right before the user prompt. Pre-9d the goal block was ALSO
    // embedded in the foundational system message (via createSystemMessage),
    // which meant every turn carried two copies; 9d made this anchor the
    // single source — `createSystemMessage` no longer touches goal state.
    // The fresh re-push every iteration keeps the up-to-date iteration
    // counter in immediate-context distance and prevents the long /goal
    // continuation-loop drift that PR #26 originally addressed. The anchor
    // also auto-folds the final-budget-turn wrap-up directive (via
    // `formatGoalBlock`'s internal `goalIsOnFinalBudgetTurn` check), so
    // the separate `goal-budget-steering` tagged message is gone too.
    if (!this.silent) {
      const activeGoal = readGoal(this.workspaceRoot, this.sessionKey);
      if (activeGoal?.text && activeGoal.status === 'active') {
        this.replaceTaggedSystemMessage('goal-anchor', formatGoalBlock(activeGoal));
      } else {
        // No active goal — drop any stale anchor from a prior /goal so the
        // model doesn't keep seeing a completed/cleared goal as "current."
        this.removeTaggedSystemMessage('goal-anchor');
      }
    }

    const userMsg = { role: 'user', content: prompt };
    this.chatHistory.push(userMsg);
    this.recordTranscript(userMsg);

    let loopCount = 0;
    // Multi-agent workflows (explorers → wait → architect → wait → write spec
    // → write tasks) can easily eat 10-15 iterations. 20 was too tight and
    // caused workflows to abort mid-architect. Cap defaults to 60 and is
    // overridable via BRAINROUTER_MAX_TOOL_LOOPS for very heavy workflows.
    const maxLoops = Math.max(5, Number(process.env.BRAINROUTER_MAX_TOOL_LOOPS) || 60);
    let finalAnswer = '';
    // Tracks whether we exited the loop because the LLM stopped requesting
    // tools (clean break) vs because we hit maxLoops. Critical: an empty
    // `finalAnswer === ''` from a clean break is NOT a loop-limit timeout.
    let exitedCleanly = false;
    // Repeat-loop guard: when the model calls the same tool with identical
    // args over and over, the result is by definition the same. Track recent
    // signatures so we can interrupt the loop with corrective feedback.
    const recentToolSignatures: string[] = [];
    const REPEAT_GUARD_LIMIT = 3;
    const spawnedChildIdsThisTurn = new Set<string>();
    const waitedChildIdsThisTurn = new Set<string>();
    const buildOrchestrationContext = (): OrchestrationContext => ({
      workspaceRoot: this.workspaceRoot,
      parentSessionKey: this.sessionKey,
      parentAccessMode: this.accessMode,
      // Thread the parent's trace context so child agents nest their
      // per-turn spans under THIS turn instead of starting a fresh
      // trace tree. Lets observability backends reconstruct fan-out.
      parentTraceId: turnSpan.traceId,
      parentSpanId: turnSpan.spanId,
      parentAgentId: this.agentId,
      parentTier: this.tier,
      depth: this.agentDepth,
      mcpClient: this.mcpClient,
      llmConfig: this.llmConfig,
      launchCwd: this.launchCwd,
      recordOffload: (chars) => { this.memoryMetrics.offloadCharsAvoided += chars; },
      onChildToolStart: (event) => {
        callbacks.onChildToolStart?.(event);
      },
      onChildToolEnd: (event) => {
        callbacks.onChildToolEnd?.(event);
      },
      onChildComplete: (event) => {
        callbacks.onChildComplete?.(event);
      },
    });

    while (loopCount < maxLoops) {
      loopCount++;
      callbacks.onStatusUpdate(`Thinking (turn ${loopCount})...`);

      let response: { content: string; toolCalls?: any[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        // Re-resolve every loop iteration so an in-session `/effort` flip
        // (which only refreshes the system prompt) also updates the next
        // request's reasoning_effort slot — no restart needed.
        const effort = resolveEffort(this.workspaceRoot).effort;
        if (shouldUseAnthropicNative(this.llmConfig)) {
          response = await callAnthropic(this.llmConfig, this.chatHistory, allTools, {
            effort,
            onThinking: (text) => callbacks.onStatusUpdate(`Thinking: ${text.slice(0, 200)}`),
          });
        } else {
          response = await callOpenAI(this.llmConfig, this.chatHistory, allTools, { effort });
        }
      } catch (err: any) {
        throw new Error(`LLM Execution failed: ${err.message}`);
      }
      if (response.usage) {
        this.lastTurnUsage.promptTokens += response.usage.prompt_tokens ?? 0;
        this.lastTurnUsage.completionTokens += response.usage.completion_tokens ?? 0;
        this.lastTurnUsage.calls += 1;
      }

      // 0.3.8-I4: Strict tool-call recovery. Real-world LLMs (especially
      // smaller / quantised) sometimes emit duplicate tool_call ids in a
      // single response. If we let both through, OpenAI's next request 400s
      // because one of the duplicates has no paired tool_result. Dedupe
      // before pushing the assistant message — last occurrence wins (closest
      // to the model's final intent).
      // Adapted from deer-flow/backend/packages/harness/deerflow/agents/
      //   middlewares/dangling_tool_call_middleware.py — same well-formed
      //   history invariant, applied per-response instead of pre-request.
      if (response.toolCalls && response.toolCalls.length > 0) {
        const deduped = dedupeToolCalls(response.toolCalls, (id) => {
          callbacks.onStatusUpdate(`Recovery: dropped duplicate tool_call id "${id}" (last occurrence wins).`);
        });
        response.toolCalls = deduped;
      }
      // Record Assistant message
      const assistantMsg: any = { role: 'assistant', content: response.content };
      if (response.toolCalls) {
        assistantMsg.tool_calls = response.toolCalls;
      }
      this.chatHistory.push(assistantMsg);
      this.recordTranscript(assistantMsg);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        const unobservedChildIds = [...spawnedChildIdsThisTurn].filter((id) => !waitedChildIdsThisTurn.has(id));
        if (unobservedChildIds.length > 0) {
          const drainTimeoutMs = Math.max(1, Number(process.env.BRAINROUTER_CHILD_DRAIN_TIMEOUT_MS) || DEFAULT_CHILD_DRAIN_TIMEOUT_MS);
          const waitName = 'wait_agents';
          const waitArgs = { ids: unobservedChildIds, timeoutMs: drainTimeoutMs };

          callbacks.onStatusUpdate(`Auto-draining ${unobservedChildIds.length} spawned child agent${unobservedChildIds.length === 1 ? '' : 's'}...`);
          callbacks.onToolStart(waitName, waitArgs);
          this.lastTurnToolCalls += 1;

          let waitResultText = '';
          let waitFailed = false;
          let waitSummary = '';
          try {
            waitResultText = await executeOrchestrationTool(waitName, waitArgs, buildOrchestrationContext());
            waitSummary = getToolSummary(waitName, waitArgs, waitResultText);
            trackChildObservation(waitName, waitArgs, waitResultText, spawnedChildIdsThisTurn, waitedChildIdsThisTurn);
          } catch (err: any) {
            // Wait tool failure: surface the error text to the model so it can
            // report failure rather than silently synthesizing stale output.
            waitFailed = true;
            waitResultText = `Tool execution failed: ${err?.message ?? String(err)}`;
            waitSummary = err?.message ?? String(err);
          }
          callbacks.onToolEnd(waitName, { success: !waitFailed, summary: waitSummary, preview: !waitFailed ? getToolPreview(waitName, waitArgs, waitResultText) : undefined });

          const timeouts = parseChildDrainTimeouts(waitResultText);
          if (timeouts.length > 0) {
            finalAnswer = formatChildDrainTimeoutAnswer(timeouts);
            exitedCleanly = true;
            break;
          }

          const correction = [
            `Runtime child-drain guardrail auto-called \`${waitName}\` because this turn spawned child agents and the model tried to answer without observing them.`,
            `Child wait result:\n${waitResultText}`,
            'Now synthesize the child output for the user. Do not say you are waiting unless the wait result timed out.',
          ].join('\n\n');
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript(guardMsg);
          continue;
        }
        finalAnswer = response.content;
        exitedCleanly = true;
        break;
      }

      // Execute tool calls chosen by the LLM.
      //
      // 0.3.8-R4 — Independent read-only tool calls (read_file, list_dir,
      // grep_search, glob_files, fetch_url, web_search, MCP memory reads)
      // are dispatched concurrently when emitted in the same assistant
      // response; consecutive serial tools (writes, shell, orchestration,
      // unknown names) execute one-by-one in their original position to
      // preserve causality. Tool-result messages are still appended to
      // chatHistory in the ORIGINAL call order so the model's next turn
      // sees a deterministic trace even if a later read settled first.
      const candidates = [
        ...LOCAL_TOOLS.map((lt) => lt.name),
        ...mcpTools.map((t: any) => t.name).filter((n: any) => typeof n === 'string'),
      ];
      const toolCalls: any[] = response.toolCalls ?? [];
      const normalizedNames = toolCalls.map((tc: any) =>
        normalizeToolName(tc.function.name, candidates),
      );
      const parallelEnabled = parallelExecutionEnabled();
      const safeFlags: boolean[] = toolCalls.map(
        (_tc: any, idx: number) => parallelEnabled && isParallelSafe(normalizedNames[idx]),
      );

      const processOneToolCall = async (tc: any, name: string): Promise<{ toolMsg: any; fullResultText: string }> => {
        this.lastTurnToolCalls += 1;
        // 0.3.8-I4: Use the strict-recovery helper so a malformed-arguments
        // tool_call surfaces as a structured tool_result (with the raw
        // arguments echoed back) instead of throwing out of the loop.
        const parsedArgs = parseArgumentsOrError(tc);
        let args: any = parsedArgs.args;
        const argParseError: string | undefined = parsedArgs.error;

        const isLocal = LOCAL_TOOLS.some(lt => lt.name === name);
        callbacks.onToolStart(name, args);

        let resultText = '';
        let isError = false;
        let summary = '';

        // If the LLM emitted malformed JSON for arguments, fail the tool call
        // up-front with a clear error so it can self-correct next turn.
        if (argParseError) {
          isError = true;
          resultText = argParseError;
          summary = 'malformed JSON args';
          callbacks.onToolEnd(name, { success: false, summary });
          traceEvent('brainrouter.tool', { tool: name, ok: false, local: isLocal, session_key: this.sessionKey, guard: 'bad_args' }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
          const toolMsg = { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError };
          return { toolMsg, fullResultText: resultText };
        }

        // Repeat-loop guard: if the model has already issued this exact
        // (name, args) call REPEAT_GUARD_LIMIT times in this turn, short-
        // circuit with corrective feedback instead of executing again.
        const signature = `${name}::${(() => { try { return JSON.stringify(args); } catch { return String(args); } })()}`;
        const repeatCount = recentToolSignatures.filter((s) => s === signature).length;
        if (repeatCount >= REPEAT_GUARD_LIMIT) {
          isError = true;
          resultText = [
            `Repeat-loop guard tripped: \`${name}\` has been called ${repeatCount + 1} times with identical args this turn.`,
            `The result hasn't changed and won't change on another call.`,
            'Pick a different action: read a different file, write the output you have, spawn a worker child, or call `goal_blocked` if no further path remains.',
          ].join(' ');
          summary = `repeat guard tripped (${repeatCount + 1}× ${name})`;
          callbacks.onToolEnd(name, { success: false, summary });
          traceEvent('brainrouter.tool', { tool: name, ok: false, local: isLocal, session_key: this.sessionKey, guard: 'repeat' }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
          const toolMsg = { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError };
          return { toolMsg, fullResultText: resultText };
        }
        recentToolSignatures.push(signature);
        // Keep the window small so the guard only blocks tight loops, not
        // legitimate revisits separated by other tool calls.
        if (recentToolSignatures.length > 12) recentToolSignatures.shift();

        // Lifecycle: pre-tool hook. Non-zero exit blocks the tool call.
        let blockedByHook: string | undefined;
        const hookifyWarnings: string[] = [];
        if (!this.silent) {
          const preResults = runHooks(this.workspaceRoot, 'pre-tool', { tool: name, payload: args });
          const denial = preResults.find((r) => r.exitCode !== 0);
          if (denial) {
            blockedByHook = (denial.stderr || denial.stdout || '').toString().trim() || `Hook ${denial.hook.id} denied tool call (exit ${denial.exitCode})`;
          }
          // Hookify markdown rules: warn/block matching by event + pattern.
          const rules = listHookifyRules(this.workspaceRoot);
          if (rules.length > 0) {
            const ctx = buildHookifyContext(name, args);
            const matches = evaluateHookify(rules, ctx);
            for (const m of matches) {
              if (m.action === 'block') {
                blockedByHook = `Hookify rule "${m.rule.name}" blocked this ${ctx.event} operation: ${m.rule.message.slice(0, 240)}`;
                break;
              }
              hookifyWarnings.push(`⚠️ ${m.rule.name}: ${m.rule.message.slice(0, 200)}`);
            }
          }
        }

        try {
          if (blockedByHook) {
            throw new Error(`Blocked by pre-tool hook: ${blockedByHook}`);
          }
          if (!allowed.has(name) && isLocal) {
            throw new Error(`Tool "${name}" is not permitted in access mode "${this.accessMode}".`);
          }
          if (isOrchestrationToolName(name)) {
            resultText = await executeOrchestrationTool(name, args, buildOrchestrationContext());
            summary = getToolSummary(name, args, resultText);
            trackChildObservation(name, args, resultText, spawnedChildIdsThisTurn, waitedChildIdsThisTurn);
          } else if (isLocal) {
            resultText = await this.executeLocalTool(name, args);
            summary = getToolSummary(name, args, resultText);
            // Plan-ticker: surface update_plan changes to the REPL so the user
            // sees the live ✓/⏳/☐ checklist instead of having to run /plan.
            if (name === 'update_plan' && Array.isArray(args.plan) && callbacks.onPlanUpdate) {
              callbacks.onPlanUpdate(args.plan, args.explanation);
            }
          } else {
            const mcpRes = await this.mcpClient.callTool(name, args);
            if (mcpRes.isError) {
              isError = true;
            }
            resultText = extractToolText(mcpRes);
            summary = `MCP: ${resultText.length} chars returned`;
          }
        } catch (err: any) {
          isError = true;
          const message = err?.message ?? String(err);
          // -32601 is JSON-RPC's MethodNotFound. We hit it most often when
          // the LLM hallucinates a tool name — typically a skill name
          // ("incremental-implementation", "spec-driven", "...-skill") that
          // it has confused for an invocable tool. Surface a correction so
          // the next iteration self-corrects instead of retrying garbage.
          if (/-32601|Unknown tool|MethodNotFound/i.test(message)) {
            const hint = explainUnknownToolName(name);
            // 0.3.8-I4: surface a "did you mean: X?" suggestion when the
            // LLM-emitted name normalises to a real registered tool (case,
            // separator, or alias mismatch). This is cheaper for the model
            // to recover from than the generic skill-vs-tool explanation.
            const didYouMean = suggestSimilarToolName(name, candidates, normalizeToolName);
            const suggestionLine = didYouMean ? `did you mean: ${didYouMean}?\n` : '';
            resultText = `Tool "${name}" does not exist. ${suggestionLine}${hint}\nUnderlying error: ${message}`;
            summary = didYouMean ? `unknown tool — did you mean ${didYouMean}?` : `unknown tool — ${hint.slice(0, 120)}`;
          } else {
            resultText = `Tool execution failed: ${message}`;
            summary = message;
          }
        }
        if (isError) {
          this.recentToolFailure = `${name}: ${summary || resultText.slice(0, 160)}`;
        }

        const finalSummary = hookifyWarnings.length > 0 ? `${summary} | ${hookifyWarnings.join(' | ')}` : summary;
        // Inspection tools (list_dir, grep_search, glob_files) commonly fail to
        // surface anything when the LLM gets lazy and replies with a stub like
        // "I have listed the directory" instead of echoing the contents. Compute
        // a short preview from the raw result so the REPL can show the user
        // SOMETHING even when the model declines to.
        const preview = !isError ? getToolPreview(name, args, resultText) : undefined;
        callbacks.onToolEnd(name, { success: !isError, summary: finalSummary, preview });
        traceEvent('brainrouter.tool', {
          tool: name,
          ok: !isError,
          local: isLocal,
          session_key: this.sessionKey,
        }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
        if (!this.silent) {
          runHooks(this.workspaceRoot, 'post-tool', {
            tool: name,
            payload: { args, ok: !isError, summary, resultPreview: resultText.slice(0, 1000) },
          });
        }

        // Tool-result clamp: huge MCP payloads (memory_recall, spawn_agent
        // outputs, big greps, file dumps) used to be re-sent to the LLM
        // verbatim every subsequent turn, which blew the context window in
        // long sessions. Clamp at ~8 KB per result for the LLM-visible copy
        // while keeping the full text on disk via recordTranscript.
        const compaction = compactToolOutput({ toolName: name, args, output: resultText });
        if (compaction.omittedChars > 0) {
          this.memoryMetrics.compactedToolCharsAvoided += compaction.omittedChars;
        }
        const llmVisibleResult = compaction.inlineText;
        const MAX_TOOL_RESULT_CHARS = Number(process.env.BRAINROUTER_MAX_TOOL_RESULT_CHARS) || 8000;
        const clampedContent = llmVisibleResult.length > MAX_TOOL_RESULT_CHARS
          ? llmVisibleResult.slice(0, MAX_TOOL_RESULT_CHARS) +
            `\n…[truncated ${llmVisibleResult.length - MAX_TOOL_RESULT_CHARS} chars after ${compaction.ruleId} compaction — full output recorded in transcript; call memory_working_offload or re-read with a narrower scope]`
          : llmVisibleResult;
        const toolMsg = {
          role: 'tool',
          tool_call_id: tc.id,
          name: name,
          content: clampedContent,
          isError
        };
        // Return; the caller pushes to chatHistory in original call order
        // (NOT settle order) and records the FULL untruncated result for
        // /transcript. Doing the push here would let parallel batches land
        // in finish order, which the LLM's next turn would see as a
        // non-deterministic trace.
        return { toolMsg, fullResultText: resultText };
      };

      // Partition the tool_calls into runs of consecutive parallel-safe
      // calls separated by single serial calls. Each run preserves original
      // position; safe runs of size ≥ 2 dispatch with Promise.allSettled,
      // serial runs (and unknown-tool fallbacks) execute one-by-one. The
      // result array is indexed by original call position so the
      // chatHistory push at the end is deterministic.
      const processed: Array<{ toolMsg: any; fullResultText: string } | undefined> =
        new Array(toolCalls.length);

      const runSafeBatch = async (startIdx: number, endIdx: number): Promise<void> => {
        // [startIdx, endIdx) — at least 1 entry; size > 1 means concurrent.
        // Calling `processOneToolCall` synchronously schedules every batch
        // member's onToolStart + repeat-guard prep BEFORE any await yields,
        // so the user sees N "in flight" tool rows immediately. Promise.
        // allSettled then waits for all to settle; any rejection is
        // translated into a "Tool execution failed" envelope so the LLM's
        // next turn still sees a tool_result for every original tool_call_id.
        const slice = toolCalls.slice(startIdx, endIdx);
        const promises = slice.map((tc: any, j: number) =>
          processOneToolCall(tc, normalizedNames[startIdx + j]),
        );
        const settled = await Promise.allSettled(promises);
        for (let k = 0; k < settled.length; k++) {
          const s = settled[k];
          if (s.status === 'fulfilled') {
            processed[startIdx + k] = s.value;
          } else {
            const tc = slice[k];
            const name = normalizedNames[startIdx + k];
            const message = s.reason?.message ?? String(s.reason);
            const resultText = `Tool execution failed: ${message}`;
            processed[startIdx + k] = {
              toolMsg: { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError: true },
              fullResultText: resultText,
            };
          }
        }
      };

      let i = 0;
      while (i < toolCalls.length) {
        if (safeFlags[i]) {
          let j = i + 1;
          while (j < toolCalls.length && safeFlags[j]) j++;
          await runSafeBatch(i, j);
          i = j;
        } else {
          // Serial slot — run in isolation so any state mutation (write,
          // spawn_agent, update_plan) completes before the next call starts.
          processed[i] = await processOneToolCall(toolCalls[i], normalizedNames[i]);
          i++;
        }
      }

      for (const entry of processed) {
        if (!entry) continue;
        this.chatHistory.push(entry.toolMsg);
        // Record the FULL untruncated result so /transcript shows everything,
        // even when the LLM-facing copy was clamped.
        this.recordTranscript({ ...entry.toolMsg, content: entry.fullResultText });
      }

      // 0.3.8-I4: orphan safety net. Even after dedupe + the per-call
      // recovery branches above, a tool_call without a paired tool_result
      // would 400 the next OpenAI request. Synthesize ERROR envelopes for
      // any unmatched id so strict tool_call ↔ tool_result pairing is
      // preserved. Synthetic content is a plain `ERROR: …` string so the
      // R1 child-drain guardrail's parseJsonObject(resultText) returns
      // undefined and we don't accidentally claim a child was spawned.
      // Synthetics do NOT bump lastTurnToolCalls — they aren't real
      // dispatches, just a well-formed-history fix.
      // Adapted from deer-flow/backend/packages/harness/deerflow/agents/
      //   middlewares/dangling_tool_call_middleware.py.
      const producedResults = processed.filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.toolMsg);
      const orphans = synthesizeOrphanResults(toolCalls, producedResults);
      for (const synthetic of orphans) {
        this.chatHistory.push(synthetic);
        this.recordTranscript(synthetic);
        callbacks.onStatusUpdate(`Recovery: synthesized placeholder for orphan tool_call ${synthetic.tool_call_id}.`);
      }
    }

    // Normalize the final answer FIRST so every exit path (loop limit, empty
    // commentary after tool calls, normal) feeds the same non-empty string
    // into both lastAnswer and captureTurn. Previously this happened AFTER
    // captureTurn, which meant memory capture + citation feedback silently
    // skipped every turn that hit the loop limit or returned no prose.
    if (!exitedCleanly) {
      this.lastTurnHitLoopLimit = true;
      finalAnswer =
        `I could not finish before the tool-call loop limit of ${maxLoops} was reached. ` +
        `Use \`/continue\` to pick up where I left off (drain pending children, finish writing artifacts), ` +
        `\`/agents\` to see what's running, or set BRAINROUTER_MAX_TOOL_LOOPS to a higher number.`;
    } else if (!finalAnswer.trim()) {
      if (this.lastGoalTransition && this.lastTurnToolCalls > 0) {
        // The model fired goal_complete / goal_blocked but skipped the
        // user-visible prose summary in the same response. Without this
        // branch the user saw "Tool calls completed (N)..." and the proof
        // string was buried in goal.json — invisible to them. Surface the
        // proof/reason directly so the work isn't wasted, and warn that
        // the model should have written a real answer.
        const goal = readGoal(this.workspaceRoot, this.sessionKey);
        const evidence = goal?.blockedReason?.trim() || '(no detail recorded)';
        const action = this.lastGoalTransition === 'complete' ? 'completed' : 'blocked';
        const field = this.lastGoalTransition === 'complete' ? 'proof' : 'reason';
        finalAnswer =
          `Goal ${action} after ${this.lastTurnToolCalls} tool call${this.lastTurnToolCalls === 1 ? '' : 's'}, ` +
          `but the model skipped writing a user-visible answer in this turn.\n\n` +
          `Recorded ${field}:\n${evidence}\n\n` +
          `(If you wanted a full analysis/report, ask "summarize what you just analyzed" — the work is in memory.)`;
      } else {
        finalAnswer = this.lastTurnToolCalls > 0
          ? `Tool calls completed (${this.lastTurnToolCalls}) and the model returned no additional commentary.`
          : 'The model returned an empty response.';
      }
    }
    this.lastAnswer = finalAnswer;

    await this.captureTurn(prompt, finalAnswer, callbacks);
    if (!this.silent) {
      runHooks(this.workspaceRoot, 'post-turn', {
        payload: { prompt, answerPreview: finalAnswer.slice(0, 1000), tokens: this.lastTurnUsage },
      });
    }
    turnSpan.end({
      outcome: exitedCleanly ? 'ok' : 'loop_limit',
      loops_used: loopCount,
      tokens_in: this.lastTurnUsage.promptTokens,
      tokens_out: this.lastTurnUsage.completionTokens,
    });
    if (!exitedCleanly) {
      // Same string as finalAnswer above; preserve the historical early-return
      // shape so callers that switch on the loop-limit branch keep working.
      return finalAnswer;
    }
    this.sessionUsage.promptTokens += this.lastTurnUsage.promptTokens;
    this.sessionUsage.completionTokens += this.lastTurnUsage.completionTokens;
    this.sessionUsage.calls += this.lastTurnUsage.calls;
    this.sessionUsage.turns += 1;
    return finalAnswer;
  }

  /** Rough token estimate (1 token ≈ 4 characters of English / code). */
  public static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async executeLocalTool(name: string, args: Record<string, any>): Promise<string> {
    // Bind path resolution to this agent's workspace, never to process.cwd().
    // The Agent might have been constructed with a workspace different from
    // the launching shell's cwd (e.g. /resume from another dir), and cwd can
    // drift in unexpected ways. Explicit beats implicit here.
    const resolveHere = (p: string, opts: { forWrite?: boolean } = {}) =>
      resolveWorkspacePath(this.workspaceRoot, p, opts);
    switch (name) {
      case 'read_file': {
        const resolved = resolveHere(args.path);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const startLine = args.startLine ? Number(args.startLine) : 1;
        const endLine = args.endLine ? Number(args.endLine) : undefined;
        
        if (startLine === 1 && endLine === undefined) {
          return content;
        }

        const lines = content.split('\n');
        const endIdx = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;
        const startIdx = Math.max(1, Math.min(startLine, lines.length));
        
        if (startIdx > endIdx) {
          return '';
        }
        
        return lines.slice(startIdx - 1, endIdx).join('\n');
      }
      case 'write_file': {
        const resolved = resolveHere(args.path, { forWrite: true });
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, args.content, 'utf8');
        return `Successfully wrote file: ${args.path}`;
      }
      case 'edit_file': {
        const resolved = resolveHere(args.path);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const target = args.targetContent;
        const replacement = args.replacementContent;

        const occurrences = content.split(target).length - 1;
        if (occurrences === 0) {
          throw new Error(`Target content not found in ${args.path}. Ensure targetContent matches exact indentation and newlines.`);
        }
        if (occurrences > 1) {
          throw new Error(`Target content found ${occurrences} times in ${args.path}. Specify more surrounding context to target uniquely.`);
        }

        const updated = content.replace(target, replacement);
        fs.writeFileSync(resolved, updated, 'utf8');
        return `Successfully edited ${args.path}`;
      }
      case 'list_dir': {
        const targetDir = resolveHere(args.path || '.');
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          throw new Error(`Directory not found: ${args.path || '.'}`);
        }
        const items = fs.readdirSync(targetDir);
        const list = items.map(item => {
          const full = path.join(targetDir, item);
          const stat = fs.statSync(full);
          return {
            name: item,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.isFile() ? stat.size : undefined
          };
        });
        return JSON.stringify(list, null, 2);
      }
      case 'grep_search': {
        const wsRoot = fs.realpathSync(this.workspaceRoot);
        const root = resolveHere(args.path || '.');
        const results: Array<{ path: string; line: number; text: string }> = [];
        
        const search = (dir: string) => {
          if (results.length >= 50) return;
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (IGNORED_DIRS.has(file)) continue;
            const full = path.join(dir, file);
            if (!isPathInside(wsRoot, fs.realpathSync(full))) continue;
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              search(full);
            } else if (stat.isFile()) {
              try {
                const content = fs.readFileSync(full, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].includes(args.query)) {
                    results.push({
                      path: path.relative(wsRoot, full),
                      line: i + 1,
                      text: lines[i].trim()
                    });
                    if (results.length >= 50) return;
                  }
                }
              } catch {
                // Ignore binary or unreadable files
              }
            }
          }
        };

        search(root);
        return JSON.stringify(results, null, 2);
      }
      case 'glob_files': {
        const pattern = args.pattern;
        if (!pattern) {
          throw new Error('Missing parameter "pattern" for glob_files.');
        }
        const matches = globFiles(pattern, this.workspaceRoot);
        return JSON.stringify(matches, null, 2);
      }
      case 'run_command': {
        const cmd = args.command;
        if (this.accessMode !== 'shell') {
          return `Command execution denied: agent access mode is "${this.accessMode}".`;
        }
        // Approval gating routes through the pure resolver in
        // runtime/dangerousCommand.ts. Three outcomes:
        //   • auto-approve: fast mode + safe command (or silent child whose
        //     parent has opted in via fast mode).
        //   • ask: planning mode, OR fast mode but the command matched the
        //     dangerous heuristic (rm -rf, sudo, force-push, …).
        //   • deny-silent: silent child agents can't answer y/N, so safe
        //     commands need parent opt-in (fast mode) and dangerous commands
        //     are always denied.
        const prefs = readPreferences(this.workspaceRoot);
        const approval = resolveRunCommandApproval(prefs, cmd, { silent: this.silent });
        if (approval === 'deny-silent') {
          if (isDangerousCommand(cmd)) {
            return (
              `Command execution denied: dangerous command in a silent child agent. ` +
              `Silent children can't answer the y/N prompt, so destructive commands ` +
              `(rm -rf, sudo, force-push, …) are refused regardless of /mode. ` +
              `Have a parent agent run this command, or split it into a safer ` +
              `equivalent.`
            );
          }
          return (
            `Command execution denied: silent child agents may not run shell ` +
            `without parent opt-in. Switch the session to \`/mode fast\` (or set ` +
            `the legacy \`autoApproveShell\` pref) to let silent children run ` +
            `safe commands, or have a parent agent run this command.`
          );
        }
        if (approval === 'auto-approve') {
          const tag = this.silent ? 'Auto-approved (silent child)' : 'Auto-approved';
          console.log(chalk.gray(`▶  ${tag}: ${chalk.cyan(cmd)}`));
        } else {
          // approval === 'ask' — interactive y/N. Use the parent REPL's
          // readline interface; spinning up an inquirer prompt opens a second
          // readline against the same stdin and dumps a stray "line" event
          // back into the parent rl when it exits, which used to surface as
          // the bogus "A previous turn is still running" warning.
          const dangerNote = isDangerousCommand(cmd)
            ? chalk.red(' (flagged as potentially destructive)')
            : '';
          console.log(`\n${chalk.yellow('⚠️  Command execution request:')} ${chalk.cyan(cmd)}${dangerNote}`);
          const approved = await askYesNo('Allow execution? (y/N) ', false);
          if (!approved) {
            return 'Command execution rejected by user.';
          }
        }

        const sandboxConfig = resolveSandboxConfig(this.workspaceRoot, {
          readPaths: prefs.sandboxReadPaths,
          writePaths: prefs.sandboxWritePaths,
        });
        const result = await runShell(cmd, sandboxConfig);
        const sandboxBadge = result.sandboxed
          ? `[sandboxed via ${result.sandboxTool}] `
          : sandboxConfig.enabled
            ? `[sandbox requested but unavailable] `
            : '';
        const notice = result.notice ? `${result.notice}\n` : '';
        return `${notice}${sandboxBadge}Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
      }
      case 'fetch_url': {
        const url = args.url;
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; BrainRouterCLI/0.3.8)'
            }
          });
          if (!res.ok) {
            throw new Error(`Failed to fetch URL: ${res.status} ${res.statusText}`);
          }
          const text = await res.text();
          if (url.includes('.html') || text.includes('<html') || text.includes('<!DOCTYPE html')) {
            const cleanText = text
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            return cleanText.slice(0, 15000);
          }
          return text.slice(0, 15000);
        } catch (err: any) {
          return `Failed to fetch URL ${url}: ${err.message}`;
        }
      }
      case 'web_search': {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('web_search requires a non-empty query.');
        const maxResults = Math.max(1, Math.min(10, Number(args.maxResults ?? 5)));
        return await runWebSearch(query, maxResults);
      }
      case 'apply_patch': {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('apply_patch requires a non-empty patch.');
        return applyPatchEnvelope(patch, this.workspaceRoot);
      }
      case 'update_plan': {
        const state = updatePlan(this.workspaceRoot, {
          explanation: args.explanation,
          plan: args.plan,
        }, this.sessionKey);
        return formatPlan(state);
      }
      case 'ask_user_choice': {
        const question = String(args.question ?? '').trim();
        const header = String(args.header ?? '').trim();
        const rawOptions: any[] = Array.isArray(args.options) ? args.options : [];
        if (!question) throw new Error('ask_user_choice requires a non-empty `question`.');
        if (!header) throw new Error('ask_user_choice requires a non-empty `header`.');
        if (rawOptions.length < 2 || rawOptions.length > 4) {
          throw new Error(`ask_user_choice requires 2–4 options; received ${rawOptions.length}.`);
        }
        const options = rawOptions.map((o, i) => {
          const label = String(o?.label ?? '').trim();
          const description = String(o?.description ?? '').trim();
          if (!label) throw new Error(`ask_user_choice option ${i + 1} is missing "label".`);
          if (!description) throw new Error(`ask_user_choice option ${i + 1} is missing "description".`);
          return { label, description };
        });
        // Silent child agents have no parent stdin/REPL bridge, so the
        // helper's TTY check would error anyway — but giving a clearer message
        // up front saves the LLM an iteration.
        if (this.silent) {
          throw new NoTTYError(
            'ask_user_choice is not available to silent child agents. Decide the answer yourself, ' +
            'state which option you picked and why, and return that as your final answer to the parent.',
          );
        }
        // Eager TTY check so we fail without disturbing the screen. askChoice
        // also checks (defense-in-depth for direct callers), but doing it here
        // means the LLM gets a clean error before the picker tries to render.
        if (!getActiveReadline() || !process.stdin.isTTY) {
          throw new NoTTYError(
            'ask_user_choice requires an interactive TTY. ' +
            'Fall back to deciding yourself and state which option you picked and why.',
          );
        }
        // header is rendered by the picker itself (chip line at the top of
        // the frame), so we just thread it through opts.
        const answer = await askChoice(question, options, {
          multiSelect: !!args.multiSelect,
          header,
        });
        return JSON.stringify({ answer });
      }
      case 'goal_complete': {
        const proof = String(args.proof ?? '').trim();
        if (!proof) throw new Error('goal_complete requires a non-empty proof.');
        // Plan-honesty guard: refuse to mark the goal complete while the
        // active plan still has pending / in_progress items. The model
        // built that plan as its own contract — declaring done while items
        // remain open is misleading (this is the exact bug the user hit
        // when /goal analyze fired with 3 of 4 plan items still ☐). The
        // model must either finish the work, explicitly mark dropped
        // items completed via update_plan (creating an audit trail), or
        // switch to goal_blocked.
        const plan = readPlan(this.workspaceRoot, this.sessionKey);
        const open = plan.items.filter((i) => i.status !== 'completed');
        if (open.length > 0) {
          const open_summary = open
            .map((i) => `  - [${i.status === 'in_progress' ? '⏳' : '☐'}] ${i.step}`)
            .join('\n');
          throw new Error(
            `goal_complete refused: the active plan still has ${open.length} incomplete item(s):\n${open_summary}\n\n` +
            `Do ONE of:\n` +
            `  1. Finish the remaining work, then call update_plan to mark those items completed.\n` +
            `  2. If you decided to drop them, call update_plan FIRST and mark them completed with a brief explanation (the plan is your honest record — leaving items pending while declaring done is misleading).\n` +
            `  3. Call goal_blocked instead if no defensible path remains.\n\n` +
            `Then retry goal_complete in the same response as the user-visible prose summary.`
          );
        }
        const goal = completeGoal(this.workspaceRoot, this.sessionKey, proof);
        if (!goal) return 'No active goal to complete.';
        this.lastGoalTransition = 'complete';
        return `Goal marked complete. Proof: ${proof}`;
      }
      case 'goal_blocked': {
        const reason = String(args.reason ?? '').trim();
        if (!reason) throw new Error('goal_blocked requires a non-empty reason.');
        const needed = String(args.needed ?? '').trim();
        const note = needed ? `${reason} (needed: ${needed})` : reason;
        const goal = blockGoal(this.workspaceRoot, this.sessionKey, note);
        if (!goal) return 'No active goal to block.';
        this.lastGoalTransition = 'blocked';
        return `Goal marked blocked. Reason: ${note}`;
      }
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }

  clearHistory() {
    this.chatHistory = [this.createSystemMessage()];
    this.initialized = true;
  }

  /**
   * Compaction for /compact: summarize current chat history via the LLM,
   * then replace the verbose log with [system, compactedSummary,
   * lastUserMessage]. Returns the summary so the REPL can display it.
   */
  public async compactHistory(): Promise<{ summary: string; estimatedTokens: number; durationMs: number; replacedMessages: number } | null> {
    if (this.chatHistory.length < 4) return null;
    const before = this.chatHistory.length;
    const userMessages = this.chatHistory.filter((m) => m.role === 'user');
    const lastUserMessage = userMessages.length > 0 ? String(userMessages[userMessages.length - 1].content ?? '') : undefined;
    const result = await runCompaction(this.llmConfig, {
      messages: this.chatHistory.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        name: m.name,
      })),
      workspaceRoot: this.workspaceRoot,
      lastUserMessage,
    });
    const next: any[] = [this.createSystemMessage(), { role: 'system', content: renderCompactSystemMessage(result.summary) }];
    if (lastUserMessage) next.push({ role: 'user', content: lastUserMessage });
    this.chatHistory = next;
    this.initialized = true;
    // 9b: compaction just dropped the prior briefing as collateral —
    // force the next turn through the full recall path even in gated
    // mode so the model isn't blind to what was load-bearing.
    this.recallNextTurnIsPostCompaction = true;
    return { ...result, replacedMessages: before };
  }

  /** Runtime model switch. Used by `/model` slash command. */
  public setModel(model: string): void {
    this.llmConfig = { ...this.llmConfig, model };
  }
  public getModel(): string {
    return this.llmConfig.model;
  }

  /** Runtime access-mode cycle for `/permissions` and Shift+Tab plan-mode toggle. */
  public getAccessMode(): AccessMode {
    return this.accessMode;
  }
  public setAccessMode(mode: AccessMode): void {
    this.accessMode = mode;
  }

  /**
   * Seed the chat history from a persisted transcript so the user can resume
   * a previous session. The system message is regenerated for the current
   * runtime so workspace/session context is fresh, but the user/assistant/tool
   * messages are kept verbatim.
   */
  public loadHistory(entries: Array<{ role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>): number {
    const replay = entries
      .filter((e) => e.role === 'user' || e.role === 'assistant' || e.role === 'tool')
      .map((e) => {
        const msg: any = { role: e.role, content: typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '') };
        if (e.name) msg.name = e.name;
        if (e.tool_call_id) msg.tool_call_id = e.tool_call_id;
        if (e.tool_calls) msg.tool_calls = e.tool_calls;
        return msg;
      });
    this.chatHistory = [this.createSystemMessage(), ...replay];
    this.initialized = true;
    // 9b: a freshly-loaded history is a session boundary; reset gated
    // recall state so the next turn refreshes the briefing.
    this.recallHasFiredThisSession = false;
    this.recallNextTurnIsPostCompaction = false;
    return replay.length;
  }

  /** Cumulative token usage across the last runTurn. Cleared at each new turn. */
  public lastTurnUsage: { promptTokens: number; completionTokens: number; calls: number } = { promptTokens: 0, completionTokens: 0, calls: 0 };

  /** Cumulative token usage across the WHOLE CLI session (all turns). */
  public sessionUsage: { promptTokens: number; completionTokens: number; calls: number; turns: number } = { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0 };

  /**
   * Memory-derived savings counters. These let `/tokens` produce a "memory
   * saved you ~N tokens" narrative the user can actually point at.
   *
   *  - briefingTokensInjected:  approx tokens added to context as memory
   *    briefings (recall + persona + scenes + recency). Each briefing
   *    provides cross-session context that would otherwise require re-reading
   *    files or re-explaining via prompts.
   *  - offloadCharsAvoided:     chars of child-agent output that were pushed
   *    to working memory instead of pasted back into parent context.
   *  - compactedToolCharsAvoided: chars omitted from model-visible tool
   *    results after semantic compaction. Raw outputs remain in transcripts.
   *  - recallRecordsConsulted:  count of memory record references the
   *    briefing put in front of the model this session.
   */
  public memoryMetrics = {
    briefingTokensInjected: 0,
    offloadCharsAvoided: 0,
    recallRecordsConsulted: 0,
    compactedToolCharsAvoided: 0,
  };

  /** Last assistant message of the most recent turn — used by `/copy`. */
  public lastAnswer = '';

  /** Last user prompt (post-mention-expansion). Used by `/continue` to resume after a loop-limit abort. */
  public lastUserPrompt = '';

  /** True when the most recent turn hit the loop-limit ceiling before producing a final answer. */
  public lastTurnHitLoopLimit = false;

  /** Count of tool calls executed during the most recent runTurn. The goal */
  /** continuation loop uses this to suppress auto-continuation after prose-only turns. */
  public lastTurnToolCalls = 0;

  /** Goal lifecycle transition the LLM triggered during the most recent turn, if any. */
  public lastGoalTransition: 'complete' | 'blocked' | undefined;

  /** Allow REPL slash commands to refresh the system prompt without bumping a new turn. */
  public refreshSystemPrompt(): void {
    if (this.chatHistory.length > 0 && this.chatHistory[0].role === 'system') {
      this.chatHistory[0] = this.createSystemMessage();
    }
  }

  /**
   * Push (or replace) a tagged system message in `chatHistory`. Per-turn
   * directives like the briefing block and the fan-out hint used to be pushed
   * unconditionally — each turn added a fresh copy without removing the prior
   * one, so a 10-turn conversation carried 10 stacked briefings. This helper
   * removes any older entry with the same tag before appending the new one,
   * keeping the model's view of "current memory state" current.
   */
  public replaceTaggedSystemMessage(tag: string, content: string): void {
    const marker = `<!--brainrouter:${tag}-->\n`;
    this.chatHistory = this.chatHistory.filter(
      (msg) => !(msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(marker)),
    );
    this.chatHistory.push({ role: 'system', content: `${marker}${content}` });
  }

  /**
   * Drop any system message previously installed under `tag`. Used to retract
   * one-off directives once the condition that motivated them no longer
   * holds — e.g. the budget-steering "wrap up gracefully" message must
   * disappear after the user extends the goal's budget, otherwise it keeps
   * telling the model "this is your last turn" for every subsequent turn.
   *
   * Idempotent: calling this with a tag that isn't present is a no-op.
   */
  public removeTaggedSystemMessage(tag: string): void {
    const marker = `<!--brainrouter:${tag}-->\n`;
    this.chatHistory = this.chatHistory.filter(
      (msg) => !(msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(marker)),
    );
  }

  /**
   * Zero the in-process counters that back `/tokens`. Call this on any
   * conceptual session boundary (`/resume`, `fork`) — otherwise the parent
   * row keeps accumulating across the switch and "this session" no longer
   * matches the displayed sessionKey.
   */
  public resetSessionCounters(): void {
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0 };
    this.memoryMetrics = {
      briefingTokensInjected: 0,
      offloadCharsAvoided: 0,
      recallRecordsConsulted: 0,
      compactedToolCharsAvoided: 0,
    };
    // 9b: session-boundary reset for gated recall.
    this.recallHasFiredThisSession = false;
    this.recallNextTurnIsPostCompaction = false;
    this.turnsSinceLastFullBriefing = 0;
    this.recentToolFailure = undefined;
  }

  /** Fork the current chat history into a fresh sessionKey. Returns the new key. */
  public fork(newSessionKey: string): string {
    this.sessionKey = newSessionKey;
    // Replace the system message so workspace/session context is fresh,
    // but keep the user/assistant/tool exchange.
    if (this.chatHistory.length > 0 && this.chatHistory[0].role === 'system') {
      this.chatHistory[0] = this.createSystemMessage();
    } else {
      this.chatHistory = [this.createSystemMessage(), ...this.chatHistory];
    }
    this.resetSessionCounters();
    return this.sessionKey;
  }

  private async bootstrapSession(callbacks: RunTurnCallbacks): Promise<void> {
    if (this.silent) {
      this.chatHistory = [this.createSystemMessage()];
      this.initialized = true;
      return;
    }
    callbacks.onStatusUpdate('Resolving BrainRouter session...');
    const resolved = await callMcpTool<{ sessionKey?: string }>(this.mcpClient, 'memory_resolve_session', {
      workspacePath: this.workspaceRoot,
      suggestedKey: this.sessionKey,
    });
    if (!resolved.isError && resolved.parsed?.sessionKey) {
      this.sessionKey = resolved.parsed.sessionKey;
    }
    // If resolution failed (missing tool, network), keep the deterministic session key we already have.

    this.chatHistory = [this.createSystemMessage()];
    this.initialized = true;
  }

  /**
   * Public, callback-free wrapper around bootstrapSession for slash commands
   * that mutate per-session state (notably `/goal`) BEFORE any runTurn has
   * fired. Without this, the FIRST `/goal` of a session writes goal.json
   * under the deterministic fallback sessionKey ("brainrouter-cli:<path>")
   * because bootstrap hasn't happened yet, but every subsequent runTurn
   * reads from the MCP-resolved UUID sessionKey — split-brain that left
   * the agent reading a stale goal from a different directory.
   *
   * Idempotent: returns immediately if already initialized. Tolerates
   * missing MCP — falls back to the deterministic key the same way
   * bootstrapSession does.
   */
  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // Stub the callbacks bootstrapSession expects — no UI plumbing needed
    // for the eager-init path; the status line is for runTurn's spinner.
    await this.bootstrapSession({
      onStatusUpdate: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    });
  }

  private createSystemMessage() {
    const prefs = readPreferences(this.workspaceRoot);
    // 10b: pass the connected MCP tool inventory so `buildSystemPrompt`
    // can omit the BrainRouter memory section when the brain is offline.
    // The cached `lastKnownMcpTools` is populated by every successful
    // `listTools()` (see `runTurn` and `bootstrapSession`); when no tools
    // have been seen yet, leave it undefined — `buildSystemPrompt` treats
    // that as "assume brain online" for back-compat.
    const connectedMcpTools = this.lastKnownMcpTools?.map((t) => t.name);
    const base = this.systemPromptOverride ?? buildSystemPrompt({
      workspaceRoot: this.workspaceRoot,
      launchCwd: this.launchCwd,
      sessionKey: this.sessionKey,
      instructionSummary: loadWorkspaceInstructionSummary(this.workspaceRoot),
      personality: prefs.personality,
      activeSkill: this.activeSkill,
      executionMode: prefs.executionMode,
      reviewPolicy: prefs.reviewPolicy,
      effort: resolveEffort(this.workspaceRoot).effort,
      connectedMcpTools,
    });
    const parts = [base];
    if (this.roleOverlay) parts.push(this.roleOverlay);
    // Goal text used to be appended here AND re-pushed as a per-turn
    // `goal-anchor` tagged system message (runTurn around line 680), which
    // meant the whole goal block landed in the prompt twice every turn.
    // 9d removed the duplicate; the per-turn anchor is the single owner
    // of goal state (text, status, budget, contract reminders, and the
    // final-budget wrap-up directive). `runTurn` re-injects it via
    // `formatGoalBlock` immediately before the user message is appended,
    // so even first-turn-after-`/resume` sees the goal.
    return { role: 'system', content: parts.join('\n\n') };
  }

  private async injectRecallContext(prompt: string, mcpTools: any[], callbacks: RunTurnCallbacks): Promise<void> {
    const resetBriefing = (details: Partial<LastBriefingDetails>) => {
      this.recalledRecords = [];
      this.recalledRecordIds = [];
      this.lastBriefingSources = [];
      this.lastBriefingDetails = {
        decision: details.decision ?? 'none',
        reasons: details.reasons ?? [],
        sources: [],
        sourcesPlanned: details.sourcesPlanned ?? [],
        skippedSources: details.skippedSources ?? [],
        sourceStats: [],
        recordIds: [],
        recordCount: 0,
        tokensInjected: 0,
        charsSaved: details.charsSaved ?? 0,
        warnings: details.warnings ?? [],
      };
    };

    if (!this.enableRecall) {
      resetBriefing({ decision: 'skip', reasons: [this.silent ? 'silent agent (child)' : 'recall disabled'] });
      callbacks.onMemoryEvent?.({ kind: 'skipped', reason: this.silent ? 'silent agent (child)' : 'recall disabled' });
      return;
    }

    // 9b: gate recall instead of firing unconditionally every turn. Pre-9b
    // every turn paid ~3-10K tokens for a fresh briefing even when the user
    // message was "thanks" or "/help". The new default `gated` mode fires
    // recall only when it's likely to pay off:
    //   - turn 1 of the session (no prior briefing)
    //   - the turn immediately after auto-compaction (the model just lost
    //     context — give it back what was load-bearing)
    //   - when the user message names ≥2 entity-shaped tokens (proper
    //     nouns, file paths, identifiers) suggesting they're asking about
    //     something specific that memory might have history on
    // The env knob `BRAINROUTER_RECALL_MODE=always|gated|off` lets users
    // preserve pre-9b behaviour or kill recall entirely for benchmarking.
    const recallMode = resolveRecallModeFromEnv();
    if (recallMode === 'off') {
      resetBriefing({ decision: 'skip', reasons: ['recallMode=off'] });
      callbacks.onMemoryEvent?.({ kind: 'skipped', reason: 'recallMode=off' });
      return;
    }

    const activeGoal = readGoal(this.workspaceRoot, this.sessionKey);
    const hasActiveGoal = !!(activeGoal?.text && activeGoal.status === 'active');
    const sourcePlan = buildDefaultSourcePlan(prompt, hasActiveGoal);
    const sourcesPlannedNames = describeSourcePlan(sourcePlan);
    const decision = decideMemoryBriefing({
      prompt,
      recallMode,
      recallHasFiredThisSession: this.recallHasFiredThisSession,
      postCompaction: this.recallNextTurnIsPostCompaction,
      hasActiveGoal,
      recentToolFailure: this.recentToolFailure,
      turnsSinceLastFullBriefing: this.turnsSinceLastFullBriefing,
    });

    if (recallMode === 'gated') {
      if (decision.action !== 'fire') {
        // Skip the full briefing — emit a lightweight system-reminder so
        // the model knows it can pull memory itself if it needs to. The
        // reminder is tagged so the next turn replaces it cleanly.
        this.replaceTaggedSystemMessage(
          'memory-hint',
          [
            '## Memory available (gated mode)',
            `Auto-briefing decision: ${decision.action}. Reasons: ${decision.reasons.join(', ')}.`,
            'Call `memory_recall` / `memory_search` / `memory_file_history` yourself if you need history on a specific entity, file, or decision.',
          ].join('\n'),
        );
        this.turnsSinceLastFullBriefing += 1;
        resetBriefing({
          decision: decision.action,
          reasons: decision.reasons,
          sourcesPlanned: sourcesPlannedNames,
        });
        callbacks.onMemoryEvent?.({ kind: 'skipped', reason: decision.reasons.join(', ') || 'gated (no trigger)' });
        return;
      }
      // Reset the post-compaction flag now that we're firing because of it.
      this.recallNextTurnIsPostCompaction = false;
    }

    // Either `recallMode === 'always'` (preserves pre-9b behaviour) or
    // we hit a gated trigger — fire the full briefing.
    callbacks.onStatusUpdate('Briefing from BrainRouter memory...');
    // 9d: skip `memory_task_state` in the briefing when a goal-anchor is
    // already carrying the current objective — avoids re-injecting the
    // "what we're doing now" context twice. The anchor is set immediately
    // before this call in `runTurn` (around line 680), so reading the goal
    // here resolves to the same record the anchor used.
    const briefing = await buildMemoryBriefing({
      mcpClient: this.mcpClient,
      mcpTools,
      sessionKey: this.sessionKey,
      workspaceRoot: this.workspaceRoot,
      query: prompt,
      activeSkill: this.activeSkill,
      hasActiveGoal,
      maxCharsPerSource: decision.budget.maxCharsPerSource,
      sourcePlan,
    });

    this.recalledRecords = briefing.recalledRecords;
    this.recalledRecordIds = briefing.recalledRecordIds;
    this.lastBriefingSources = briefing.sourcesQueried;
    this.recallHasFiredThisSession = true;
    this.turnsSinceLastFullBriefing = 0;
    this.recentToolFailure = undefined;
    // Drop any prior lightweight hint now that the full briefing is live.
    this.removeTaggedSystemMessage('memory-hint');

    const tokensInjected = briefing.block ? Agent.estimateTokens(briefing.block) : 0;
    this.lastBriefingDetails = {
      decision: 'fire',
      reasons: decision.reasons,
      sources: briefing.sourcesQueried,
      sourcesPlanned: briefing.sourcesPlanned,
      skippedSources: briefing.skippedSources,
      sourceStats: briefing.sourceStats,
      recordIds: briefing.recalledRecordIds,
      recordCount: briefing.recalledRecordIds.length,
      tokensInjected,
      charsSaved: this.memoryMetrics.compactedToolCharsAvoided,
      warnings: briefing.warnings,
    };

    if (briefing.block) {
      this.replaceTaggedSystemMessage('memory-briefing', briefing.block);
      callbacks.onStatusUpdate(
        `Memory briefing loaded: ${briefing.sourcesQueried.join(', ')} (${briefing.recalledRecordIds.length} records).`,
      );
      this.memoryMetrics.briefingTokensInjected += tokensInjected;
      this.memoryMetrics.recallRecordsConsulted += briefing.recalledRecordIds.length;
    }
    callbacks.onMemoryEvent?.({
      kind: 'briefing',
      sources: briefing.sourcesQueried,
      recordCount: briefing.recalledRecordIds.length,
    });
  }

  /** Inspectable summary of the most recent memory briefing. Used by the `/briefing` slash command. */
  public getLastBriefing(): LastBriefingDetails {
    return {
      ...this.lastBriefingDetails,
      sources: [...this.lastBriefingDetails.sources],
      sourcesPlanned: [...this.lastBriefingDetails.sourcesPlanned],
      skippedSources: [...this.lastBriefingDetails.skippedSources],
      sourceStats: [...this.lastBriefingDetails.sourceStats],
      recordIds: [...this.lastBriefingDetails.recordIds],
      reasons: [...this.lastBriefingDetails.reasons],
      warnings: [...this.lastBriefingDetails.warnings],
    };
  }

  /**
   * Snapshot of the records produced by the most recent pre-turn briefing.
   * `/where` surfaces a few of these to give the user a sense of what the
   * agent is leaning on right now. Returns a shallow copy so callers can't
   * mutate the agent's internal state.
   */
  public getRecalledRecords(): RecalledRecord[] {
    return [...this.recalledRecords];
  }

  /** One-line summary of any new contradiction surfaced after the last capture, or undefined if none. */
  private lastContradictionWarning?: string;
  public takeContradictionWarning(): string | undefined {
    const w = this.lastContradictionWarning;
    this.lastContradictionWarning = undefined;
    return w;
  }

  private async checkContradictions(callbacks?: RunTurnCallbacks): Promise<void> {
    if (!this.enableRecall) return;
    const res = await callMcpTool<any>(this.mcpClient, 'memory_contradictions', { action: 'list' });
    if (res.isError || !res.parsed) return;
    const list = res.parsed?.contradictions ?? res.parsed?.items ?? res.parsed;
    if (!Array.isArray(list) || list.length === 0) return;
    const first = list[0];
    const summary = first?.summary || first?.description || first?.title || JSON.stringify(first).slice(0, 200);
    this.lastContradictionWarning = `${list.length} unresolved contradiction(s). First: ${summary}`;
    callbacks?.onMemoryEvent?.({ kind: 'contradiction', warning: this.lastContradictionWarning });
  }

  private async captureTurn(prompt: string, finalAnswer: string, callbacks?: RunTurnCallbacks): Promise<void> {
    if (this.silent) return;
    if (!finalAnswer) return;
    const timestamp = Date.now();

    try {
      if (this.recalledRecordIds.length > 0) {
        const cited = selectCitedRecordIds(this.recalledRecords, finalAnswer);
        await this.mcpClient.callTool('memory_mark_cited', {
          citedRecordIds: cited,
          allRecalledRecordIds: this.recalledRecordIds,
        });
        if (cited.length > 0) {
          callbacks?.onMemoryEvent?.({ kind: 'citation', recordIds: cited });
        }
      }
    } catch {
      // Citation feedback should not break the user-facing turn.
    }

    try {
      const captureRes = await this.mcpClient.callTool('memory_capture_turn', {
        sessionKey: this.sessionKey,
        activeSkill: this.activeSkill,
        messages: [
          { role: 'user', content: redactText(prompt), timestamp },
          { role: 'assistant', content: redactText(finalAnswer), timestamp: Date.now() },
        ],
      });
      // Parse the structured result so the REPL can tell "wrote 2 sensory + 0
      // cognitive (extractor not running)" apart from "wrote 2 + 3 cognitive
      // — fully captured." Previously the CLI printed 💾 Captured even when
      // the extractor was silently disabled, leaving the user to discover
      // the gap by running SQL against memory.db.
      let parsed: any;
      try {
        const text = extractToolText(captureRes);
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      // Only warn when the LLM call ITSELF failed (status === 'failed').
      // A successful call that returned 0 records is a legitimate "nothing
      // notable to capture" outcome (e.g. a greeting) and should not look
      // like an error to the user. The previous heuristic conflated both
      // and surfaced a misleading warning after every trivial exchange.
      const status: 'ok' | 'failed' | 'skipped' | undefined = parsed?.cognitiveExtractionStatus;
      const extractionWarning = status === 'failed'
        ? (typeof parsed?.cognitiveExtractionError === 'string'
            ? `extraction failed: ${parsed.cognitiveExtractionError.slice(0, 140)}`
            : 'extraction failed — check MCP server logs and LLM credentials')
        : undefined;
      callbacks?.onMemoryEvent?.({
        kind: 'capture',
        sessionKey: this.sessionKey,
        messageCount: 2,
        sensoryRecorded: typeof parsed?.sensoryRecordedCount === 'number' ? parsed.sensoryRecordedCount : undefined,
        extractionTriggered: typeof parsed?.cognitiveExtractionTriggered === 'boolean' ? parsed.cognitiveExtractionTriggered : undefined,
        extractedCount: typeof parsed?.cognitiveExtractedCount === 'number' ? parsed.cognitiveExtractedCount : undefined,
        extractionWarning,
      });
    } catch {
      // Passive capture is best effort in the CLI.
    }

    await this.checkContradictions(callbacks);
  }

  private recordTranscript(message: any): void {
    try {
      appendTranscriptEntry(this.workspaceRoot, this.sessionKey, message);
    } catch {
      // Transcript persistence should not break the interactive turn.
    }
  }
}

/**
 * Run a web search via DuckDuckGo's Instant Answer API. No API key required.
 *
 * This is a thin, dependency-free default. For production-grade results, users
 * can configure an upstream search provider (Brave / Tavily / SerpAPI) and
 * point `BRAINROUTER_WEB_SEARCH_ENDPOINT` at it — when set, we POST the query
 * and expect `{ results: [{title, url, snippet}] }`.
 */
async function runWebSearch(query: string, maxResults: number): Promise<string> {
  const customEndpoint = process.env.BRAINROUTER_WEB_SEARCH_ENDPOINT?.trim();
  if (customEndpoint) {
    try {
      const res = await fetch(customEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      });
      if (res.ok) {
        const body = await res.json() as any;
        if (Array.isArray(body?.results)) {
          return JSON.stringify(body.results.slice(0, maxResults), null, 2);
        }
      }
    } catch {
      // fall through to DuckDuckGo fallback
    }
  }

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BrainRouterCLI/0.3.8' } });
    if (!res.ok) {
      return `web_search failed: DuckDuckGo returned ${res.status} ${res.statusText}.`;
    }
    const data = await res.json() as any;
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    if (data?.AbstractURL && data?.AbstractText) {
      results.push({ title: data.Heading ?? query, url: data.AbstractURL, snippet: data.AbstractText });
    }
    const topics = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
    for (const t of topics) {
      if (results.length >= maxResults) break;
      if (t.FirstURL && t.Text) {
        results.push({ title: t.Text.split(' - ')[0] ?? t.Text, url: t.FirstURL, snippet: t.Text });
      } else if (Array.isArray(t?.Topics)) {
        for (const inner of t.Topics) {
          if (results.length >= maxResults) break;
          if (inner.FirstURL && inner.Text) {
            results.push({ title: inner.Text.split(' - ')[0] ?? inner.Text, url: inner.FirstURL, snippet: inner.Text });
          }
        }
      }
    }
    if (results.length === 0) {
      return `web_search returned no results for "${query}". DuckDuckGo Instant Answer is best for factual queries; configure BRAINROUTER_WEB_SEARCH_ENDPOINT for a full search backend.`;
    }
    return JSON.stringify(results.slice(0, maxResults), null, 2);
  } catch (err: any) {
    return `web_search failed: ${err?.message ?? err}`;
  }
}

/**
 * Apply a Begin/End-envelope patch:
 *
 *   *** Begin Patch
 *   *** Update File: path/relative/to/workspace
 *   @@ optional context anchor
 *   -old line
 *   +new line
 *    unchanged line
 *   *** Add File: another/path
 *   +line 1
 *   +line 2
 *   *** Delete File: third/path
 *   *** End Patch
 *
 * Returns a JSON summary of operations performed; throws on a malformed envelope
 * or when an Update fails to match its context block uniquely.
 */
export function applyPatchEnvelope(patch: string, workspaceRoot?: string): string {
  const text = patch.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('*** Begin Patch')) {
    throw new Error('apply_patch: missing "*** Begin Patch" header.');
  }
  if (!text.endsWith('*** End Patch')) {
    throw new Error('apply_patch: missing "*** End Patch" footer.');
  }
  const inner = text.slice('*** Begin Patch'.length, text.length - '*** End Patch'.length);
  const lines = inner.split('\n');

  type Op =
    | { kind: 'update'; file: string; oldBlock: string; newBlock: string }
    | { kind: 'add'; file: string; body: string }
    | { kind: 'delete'; file: string };

  const ops: Op[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** Update File: ')) {
      const file = line.slice('*** Update File: '.length).trim();
      i++;
      // Optional @@ anchor (single line for now).
      if (i < lines.length && lines[i].startsWith('@@')) {
        i++;
      }
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const l = lines[i];
        if (l.startsWith('-')) {
          oldLines.push(l.slice(1));
        } else if (l.startsWith('+')) {
          newLines.push(l.slice(1));
        } else if (l.startsWith(' ')) {
          oldLines.push(l.slice(1));
          newLines.push(l.slice(1));
        } else if (l === '') {
          // tolerate blank lines as untouched
          oldLines.push('');
          newLines.push('');
        } else {
          throw new Error(`apply_patch: unexpected line in Update File "${file}": ${JSON.stringify(l)}`);
        }
        i++;
      }
      ops.push({ kind: 'update', file, oldBlock: oldLines.join('\n'), newBlock: newLines.join('\n') });
    } else if (line.startsWith('*** Add File: ')) {
      const file = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        const l = lines[i];
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l === '') body.push('');
        else throw new Error(`apply_patch: Add File "${file}" lines must start with '+': ${JSON.stringify(l)}`);
        i++;
      }
      ops.push({ kind: 'add', file, body: body.join('\n') });
    } else if (line.startsWith('*** Delete File: ')) {
      const file = line.slice('*** Delete File: '.length).trim();
      ops.push({ kind: 'delete', file });
      i++;
    } else if (line === '' || line.startsWith('***')) {
      i++;
    } else {
      throw new Error(`apply_patch: expected an operation header, got ${JSON.stringify(line)}`);
    }
  }

  const applied: Array<{ kind: string; file: string }> = [];
  const wsRoot = workspaceRoot ?? fs.realpathSync(process.cwd());
  for (const op of ops) {
    const resolved = resolveWorkspacePath(wsRoot, op.file, { forWrite: op.kind !== 'delete' });
    if (op.kind === 'add') {
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(resolved)) {
        throw new Error(`apply_patch: Add File "${op.file}" already exists. Use Update File instead.`);
      }
      fs.writeFileSync(resolved, op.body, 'utf8');
      applied.push({ kind: 'add', file: op.file });
    } else if (op.kind === 'delete') {
      if (!fs.existsSync(resolved)) {
        throw new Error(`apply_patch: Delete File "${op.file}" does not exist.`);
      }
      fs.unlinkSync(resolved);
      applied.push({ kind: 'delete', file: op.file });
    } else {
      if (!fs.existsSync(resolved)) {
        throw new Error(`apply_patch: Update File "${op.file}" does not exist.`);
      }
      const content = fs.readFileSync(resolved, 'utf8');
      const count = op.oldBlock === '' ? 0 : content.split(op.oldBlock).length - 1;
      if (count === 0) {
        throw new Error(`apply_patch: context for Update File "${op.file}" did not match. Re-read the file and resubmit.`);
      }
      if (count > 1) {
        throw new Error(`apply_patch: context for Update File "${op.file}" matched ${count} times. Add more surrounding lines for uniqueness.`);
      }
      const updated = content.replace(op.oldBlock, op.newBlock);
      fs.writeFileSync(resolved, updated, 'utf8');
      applied.push({ kind: 'update', file: op.file });
    }
  }

  return JSON.stringify({ applied }, null, 2);
}

export function matchGlob(pattern: string, filePath: string): boolean {
  const base = path.basename(filePath);
  const convertPattern = (p: string) => new RegExp(`^${globToRegexSource(p)}$`);

  const normPath = filePath.replace(/\\/g, '/');
  if (convertPattern(pattern).test(normPath)) {
    return true;
  }
  
  if (!pattern.includes('/') && convertPattern(pattern).test(base)) {
    return true;
  }
  
  return false;
}

function globToRegexSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '.';
      continue;
    }

    source += char.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return source;
}

export function globFiles(pattern: string, workspaceRoot?: string, dir?: string): string[] {
  const wsRoot = fs.realpathSync(workspaceRoot ?? process.cwd());
  const startDir = dir ?? wsRoot;
  const safeDir = resolveWorkspacePath(wsRoot, path.relative(wsRoot, startDir) || '.');
  const results: string[] = [];
  const items = fs.readdirSync(safeDir);
  for (const item of items) {
    if (IGNORED_DIRS.has(item)) {
      continue;
    }
    const fullPath = path.join(safeDir, item);
    if (!isPathInside(wsRoot, fs.realpathSync(fullPath))) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...globFiles(pattern, wsRoot, fullPath));
    } else if (stat.isFile()) {
      const relPath = path.relative(wsRoot, fullPath);
      if (matchGlob(pattern, relPath)) {
        results.push(relPath);
      }
    }
  }
  return results;
}

export function getToolSummary(name: string, args: Record<string, any>, result: string): string {
  switch (name) {
    case 'read_file': {
      const lines = result.split('\n').length;
      return `read ${lines} lines (${result.length} characters) from ${args.path}`;
    }
    case 'write_file':
      return `wrote to ${args.path}`;
    case 'edit_file':
      return `edited ${args.path}`;
    case 'list_dir':
      try {
        const items = JSON.parse(result);
        return `listed ${items.length} items in ${args.path || '.'}`;
      } catch {
        return `listed directory ${args.path || '.'}`;
      }
    case 'grep_search':
      try {
        const matches = JSON.parse(result);
        return `found ${matches.length} matches for "${args.query}"`;
      } catch {
        return `searched for "${args.query}"`;
      }
    case 'glob_files':
      try {
        const matched = JSON.parse(result);
        return `found ${matched.length} files matching "${args.pattern}"`;
      } catch {
        return `searched pattern "${args.pattern}"`;
      }
    case 'run_command':
      if (result.includes('rejected by user')) {
        return 'execution rejected by user';
      }
      const exitCodeMatch = result.match(/Exit Code: (\d+)/);
      const code = exitCodeMatch ? exitCodeMatch[1] : '0';
      return `exited with code ${code}`;
    case 'fetch_url':
      if (result.startsWith('Failed')) {
        return 'failed web fetch';
      }
      return `fetched content from ${args.url}`;
    case 'web_search':
      try { return `${JSON.parse(result).length} web results for "${args.query}"`; } catch { return `searched web for "${args.query}"`; }
    case 'apply_patch':
      try { return `applied ${JSON.parse(result).applied.length} file ops`; } catch { return 'applied patch'; }
    case 'update_plan':
      return 'updated durable plan';
    case 'spawn_agent':
      return `spawned ${args.role} agent`;
    case 'list_agents':
      try { return `${JSON.parse(result).length} child sessions`; } catch { return 'listed agents'; }
    case 'wait_agent':
      try { const p = JSON.parse(result); return `agent ${p.id} ${p.status}`; } catch { return 'waited'; }
    case 'read_agent_transcript':
      try { return `${JSON.parse(result).entries?.length || 0} transcript entries`; } catch { return 'read transcript'; }
    case 'close_agent':
      return `closed agent ${args.id}`;
    default:
      return `${name} executed`;
  }
}

/**
 * Optional inline preview for inspection-style tools. The REPL renders this
 * indented below the one-line summary so the user can SEE the result even if
 * the LLM forgets to echo it in its reply. Limited to a handful of tools where
 * the result is concise and the user's intent is almost always "show me this":
 * `list_dir`, `grep_search`, `glob_files`. Other tools (read_file, run_command)
 * fire too often as internal exploration steps — previewing them would flood
 * the terminal. Returns undefined when no useful preview is available.
 */
export function getToolPreview(name: string, args: Record<string, any>, result: string): string | undefined {
  switch (name) {
    case 'list_dir': {
      try {
        const items = JSON.parse(result) as Array<{ name: string; type: string; size?: number }>;
        if (!Array.isArray(items)) return undefined;
        if (items.length === 0) return '(empty directory)';
        const MAX = 30;
        const sliced = items.slice(0, MAX);
        const lines = sliced.map((it) => {
          const tag = it.type === 'directory' ? '📁' : '📄';
          const size = it.type === 'file' && typeof it.size === 'number' ? ` (${formatBytes(it.size)})` : '';
          return `${tag} ${it.name}${size}`;
        });
        if (items.length > MAX) lines.push(`…and ${items.length - MAX} more`);
        return lines.join('\n');
      } catch {
        return undefined;
      }
    }
    case 'grep_search': {
      try {
        const matches = JSON.parse(result) as Array<{ path: string; line: number; text: string }>;
        if (!Array.isArray(matches)) return undefined;
        if (matches.length === 0) return '(no matches)';
        const MAX = 10;
        const sliced = matches.slice(0, MAX);
        const lines = sliced.map((m) => `${m.path}:${m.line}  ${m.text.slice(0, 120)}`);
        if (matches.length > MAX) lines.push(`…and ${matches.length - MAX} more`);
        return lines.join('\n');
      } catch {
        return undefined;
      }
    }
    case 'glob_files': {
      try {
        const paths = JSON.parse(result) as string[];
        if (!Array.isArray(paths)) return undefined;
        if (paths.length === 0) return '(no matches)';
        const MAX = 20;
        const sliced = paths.slice(0, MAX);
        const lines = sliced.map((p) => p);
        if (paths.length > MAX) lines.push(`…and ${paths.length - MAX} more`);
        return lines.join('\n');
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Internal marker lines used by Agent.replaceTaggedSystemMessage to dedupe
// per-turn system messages (briefing, fan-out hint). Strip them before the
// payload reaches the LLM so the model doesn't see the bookkeeping.
const TAG_MARKER_RE = /^<!--brainrouter:[a-z0-9-]+-->\n/;

/**
 * Heuristic for "does this model accept the OpenAI Chat Completions
 * `reasoning_effort` field?". The signal that actually matters is the
 * **model name**, not the endpoint hostname — modern OpenAI-compatible
 * servers (LM Studio 0.3.29+, Ollama, vLLM, OpenRouter, OpenAI itself)
 * all accept the field on /v1/chat/completions for the reasoning-capable
 * model classes below, and silently ignore it for everything else. So a
 * `gpt-oss-20b` served from localhost via LM Studio gets the same
 * treatment as `gpt-5` on `api.openai.com`.
 *
 * Borrowed shape from openai-node's `ReasoningEffort` enum
 * (openSrc/openai-node/src/resources/shared.ts) — `low|medium|high` map
 * straight through to the provider field across OpenAI, DeepSeek,
 * LM Studio, Ollama, and OpenRouter's pass-through. Anthropic models
 * (`claude-*`) use a different field shape (`thinking: { budget_tokens }`)
 * and a different endpoint (`/v1/messages`), so they're intentionally
 * skipped here — brainrouter would need a separate provider adapter to
 * forward into Anthropic's native API.
 */

/**
 * 9b: resolve the recall-gating mode for this process. `BRAINROUTER_RECALL_MODE`
 * env var beats everything; unset defaults to `gated`. Anything outside the
 * three valid values falls back to `gated` (defensive — better to be helpful
 * than crash on a typo). Re-resolved each turn so users can flip with
 * `export BRAINROUTER_RECALL_MODE=always` mid-session via a /run command.
 */
export function resolveRecallMode(): 'always' | 'gated' | 'off' {
  return resolveRecallModeFromEnv();
}

/**
 * 9b: cheap local heuristic for "the user message names something specific
 * memory might have history on." Counts entity-shaped tokens: proper nouns
 * (capitalized words that aren't sentence-starting), file paths (anything
 * with `/` or `\\` or a `.<ext>` suffix), and identifier-shaped tokens (`camelCase`
 * / `snake_case` / `PascalCase` longer than 4 chars). Crude but the bar is
 * "is recall plausibly worth it?" — false positives waste a recall call,
 * false negatives waste an ask. Tunable threshold via the caller.
 */
export function countEntityTokens(text: string): number {
  return countEntityTokensFromText(text);
}

export function supportsReasoningEffortField(config: LLMConfig): boolean {
  // Normalize the model name: strip any `<vendor>/` prefix so OpenRouter /
  // LM Studio naming (`openai/gpt-oss-20b`, `mistralai/magistral-small`,
  // `deepseek/deepseek-r1`) matches the same patterns as a bare model name.
  // Some servers stack multiple prefixes (`openai/gpt-oss/20b-variant`), so
  // we keep only the segment after the LAST `/`.
  const raw = (config.model ?? '').toLowerCase();
  const model = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;

  // Reasoning-model name patterns. The list covers the major reasoning
  // model families running through OpenAI-compatible /chat/completions
  // surfaces in 2026: OpenAI's gpt-5 / o-series / open-weights gpt-oss,
  // DeepSeek's R1 / R2 / V3+ thinking variants, Alibaba's Qwen3 thinking
  // models, Mistral's Magistral, and Microsoft's Phi-4-reasoning. Any
  // model whose name itself contains "reasoning" or "thinking" is
  // included too — that catches new entrants we haven't enumerated yet
  // (e.g. `phi-4-reasoning-plus`, `qwen3-30b-a3b-thinking`).
  const reasoningPatterns = [
    /^gpt-5/,            // gpt-5, gpt-5-mini, gpt-5-pro, gpt-5.1, gpt-5-codex-max
    /^o[134](-|$|\.)/,   // o1, o3, o4 and dated / sized variants
    /^gpt-oss/,          // gpt-oss-20b / 120b (LM Studio 0.3.29+, Ollama, llama.cpp)
    /^deepseek-r[12]/,   // DeepSeek R1, R2
    /^deepseek-v[34]/,   // DeepSeek V3.1+, V4 reasoning variants
    /^qwen3/,            // Qwen3 reasoning variants (LM Studio, Ollama)
    /^magistral/,        // Mistral Magistral (small/medium reasoning)
    /reasoning/,         // catch-all for `phi-4-reasoning`, `*-reasoning-plus`, …
    /thinking/,          // catch-all for `qwen3-30b-a3b-thinking`, `*-thinking-*`, …
  ];
  return reasoningPatterns.some((re) => re.test(model));
}

export interface BuildPayloadOptions {
  /** Reasoning-depth preference, when provider supports it. `medium` is a no-op. */
  effort?: EffortLevel;
}

export function buildChatCompletionPayload(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
): ChatCompletionPayload {
  const stripTag = (content: any) =>
    typeof content === 'string' && TAG_MARKER_RE.test(content)
      ? content.replace(TAG_MARKER_RE, '')
      : content;
  const mappedMessages = messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id,
        name: m.name,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      };
    }
    if (m.role === 'assistant') {
      const out: any = { role: 'assistant', content: m.content || null };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      return out;
    }
    return {
      role: m.role,
      content: stripTag(m.content),
    };
  });

  const body: ChatCompletionPayload = {
    model: config.model,
    messages: mappedMessages,
  };

  if (tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} }
      }
    }));
    body.tool_choice = 'auto';
  }

  // Forward reasoning_effort only when the level is non-default AND the
  // endpoint+model combo is a known reasoning surface. `medium` is the
  // CLI default and forwarding it would change every existing user's
  // request shape on upgrade for no behavioural gain.
  if (options.effort && options.effort !== 'medium' && supportsReasoningEffortField(config)) {
    body.reasoning_effort = options.effort;
  }

  return body;
}

export async function callOpenAI(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
) {
  // Normalize the endpoint to a base URL (everything UP TO `/chat/completions`
  // exclusive). Earlier callers stored the full chat-completions URL in
  // `config.endpoint` (e.g. "https://api.openai.com/v1/chat/completions")
  // because the in-terminal wizard's provider catalog wrote the full path.
  // We then re-append `/chat/completions` below, producing a duplicate
  // `/chat/completions/chat/completions` and a 404. Strip the suffix
  // defensively so both shapes (full URL or base URL) work.
  const rawEndpoint = config.endpoint || 'https://api.openai.com/v1';
  const endpoint = rawEndpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  let apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
  const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
  if (!apiKey && !isLocal) {
    throw new Error('LLM API key is required for OpenAI provider.');
  }
  if (!apiKey && isLocal) {
    apiKey = 'sk-local-placeholder';
  }

  const body = buildChatCompletionPayload(config, messages, tools, options);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const timeoutMs = Number(process.env.BRAINROUTER_LLM_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Gate every chat LLM call through the process-wide semaphore. This
  // prevents a fan-out of N parallel children from firing N simultaneous
  // requests at the backend — the same condition that was unloading the
  // local LM Studio model. The MCP child has its own matching semaphore;
  // both consume the BRAINROUTER_LLM_MAX_CONCURRENT budget on the same
  // backend instance.
  const release = await acquireLLMSlot();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    release();
    if (err?.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${timeoutMs}ms. Check that ${endpoint} is running and that model "${config.model}" can answer chat/completions requests with tools enabled.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  // Release once the headers are back; reading the body is local work that
  // doesn't need to block other LLM callers from starting.
  release();

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${res.statusText} - ${errText}`);
  }

  const data = await res.json() as any;

  // Defensive response-shape parsing. Some endpoints (LM Studio with certain
  // models, OpenRouter on specific upstream errors, local vLLM under load,
  // gpt-oss reasoning models with a non-standard envelope) return a 200 OK
  // with NO `choices` array — they smuggle the failure into the body as
  // `{error: ...}` or change the schema entirely. Unguarded `data.choices[0]`
  // then crashes with "Cannot read properties of undefined" and the user
  // has no idea what the upstream actually sent. Surface the body in the
  // error so they can spot the actual problem (wrong model name, OOM,
  // content-filter refusal, etc.).
  if (data && typeof data === 'object' && data.error) {
    const errMsg = typeof data.error === 'string'
      ? data.error
      : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
    throw new Error(`LLM endpoint returned an error envelope (HTTP 200): ${errMsg}`);
  }
  if (!Array.isArray(data?.choices) || data.choices.length === 0) {
    throw new Error(
      `LLM endpoint returned no choices. ` +
      `Model "${config.model}" at ${endpoint} may not support chat/completions, ` +
      `may need a different request shape (reasoning/harmony format?), or be misconfigured. ` +
      `Response body: ${JSON.stringify(data).slice(0, 600)}`,
    );
  }
  const choice = data.choices[0];
  if (!choice?.message) {
    // Streaming-style frames have `delta` instead of `message` — accept both
    // so a partially-misconfigured endpoint at least surfaces what it sent.
    const delta = choice?.delta;
    if (delta && typeof delta === 'object') {
      return {
        content: delta.content || '',
        toolCalls: delta.tool_calls,
        usage: data.usage,
      };
    }
    throw new Error(`OpenAI-compatible endpoint returned an invalid chat completion response: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return {
    // Some reasoning models put the visible answer in `message.content` and
    // chain-of-thought in `message.reasoning_content` / `reasoning`. We use
    // content (the canonical user-visible field) but tolerate it being null
    // when there are tool_calls but no prose.
    content: choice.message.content ?? '',
    toolCalls: choice.message.tool_calls,
    usage: data.usage,
  };
}
