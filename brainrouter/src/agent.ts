import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import inquirer from 'inquirer';
import type { McpClientWrapper } from './mcpClient.js';
import type { LLMConfig } from './config.js';
import { appendTranscriptEntry } from './sessionStore.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from './systemPrompt.js';
import { formatPlan, updatePlan } from './taskStore.js';
import type { AccessMode } from './agentRoles.js';
import {
  createSpawnAgentTool,
  createListAgentsTool,
  createWaitAgentTool,
  createReadAgentTranscriptTool,
  createCloseAgentTool,
  executeOrchestrationTool,
  isOrchestrationToolName,
} from './orchestratorTools.js';
import { buildMemoryBriefing, selectCitedRecordIds, type RecalledRecord } from './memoryBriefing.js';
import { callMcpTool, extractToolText } from './mcpUtils.js';

const execPromise = promisify(exec);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.DS_Store', '.next']);

export interface RunTurnCallbacks {
  onStatusUpdate: (status: string) => void;
  onToolStart: (name: string, args: Record<string, any>) => void;
  onToolEnd: (name: string, result: { success: boolean; summary: string }) => void;
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
  createSpawnAgentTool(),
  createListAgentsTool(),
  createWaitAgentTool(),
  createReadAgentTranscriptTool(),
  createCloseAgentTool(),
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
  }
];

export function getWorkspaceRoot(): string {
  return fs.realpathSync(process.cwd());
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(inputPath = '.', options: { forWrite?: boolean } = {}): string {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('Path must be a non-empty string.');
  }

  const root = getWorkspaceRoot();
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
  private roleOverlay?: string;
  private accessMode: AccessMode;
  private silent: boolean;
  private enableRecall: boolean;
  private systemPromptOverride?: string;

  constructor(mcpClient: McpClientWrapper, llmConfig: LLMConfig, options: AgentOptions) {
    this.mcpClient = mcpClient;
    this.llmConfig = llmConfig;
    this.workspaceRoot = options.workspaceRoot;
    this.launchCwd = options.launchCwd;
    this.sessionKey = options.sessionKey ?? `brainrouter-cli:${this.workspaceRoot}`;
    this.roleOverlay = options.roleOverlay;
    this.accessMode = options.accessMode ?? 'shell';
    this.silent = options.silent ?? false;
    // Children default to no recall (their seed context already covers the parent's recall).
    // Parents (non-silent) always recall.
    this.enableRecall = options.enableRecall ?? !this.silent;
    this.systemPromptOverride = options.systemPromptOverride;
  }

  private allowedToolsForAccess(): Set<string> {
    const readOnly = new Set(['read_file', 'list_dir', 'grep_search', 'glob_files', 'fetch_url', 'update_plan',
      'spawn_agent', 'list_agents', 'wait_agent', 'read_agent_transcript', 'close_agent']);
    const writeAdds = new Set(['write_file', 'edit_file']);
    const shellAdds = new Set(['run_command']);
    if (this.accessMode === 'read') return readOnly;
    if (this.accessMode === 'write') return new Set([...readOnly, ...writeAdds]);
    return new Set([...readOnly, ...writeAdds, ...shellAdds]);
  }

  async runTurn(prompt: string, callbacks: RunTurnCallbacks): Promise<string> {
    if (!this.initialized) {
      await this.bootstrapSession(callbacks);
    }

    callbacks.onStatusUpdate('Loading available tools...');
    let mcpTools: any[] = [];
    try {
      const toolsRes = await this.mcpClient.listTools();
      mcpTools = toolsRes.tools || [];
    } catch (err: any) {
      // Non-fatal: continue with local tools only
    }

    const allowed = this.allowedToolsForAccess();
    const filteredLocalTools = LOCAL_TOOLS.filter(t => allowed.has(t.name));
    const allTools = [...filteredLocalTools, ...mcpTools];
    callbacks.onStatusUpdate(`Loaded ${filteredLocalTools.length} local tools and ${mcpTools.length} MCP tools.`);
    await this.injectRecallContext(prompt, mcpTools, callbacks);

    const userMsg = { role: 'user', content: prompt };
    this.chatHistory.push(userMsg);
    this.recordTranscript(userMsg);

    let loopCount = 0;
    const maxLoops = 20;
    let finalAnswer = '';

    while (loopCount < maxLoops) {
      loopCount++;
      callbacks.onStatusUpdate(`Thinking (turn ${loopCount})...`);

      let response: { content: string; toolCalls?: any[] };
      try {
        response = await callOpenAI(this.llmConfig, this.chatHistory, allTools);
      } catch (err: any) {
        throw new Error(`LLM Execution failed: ${err.message}`);
      }

      // Record Assistant message
      const assistantMsg: any = { role: 'assistant', content: response.content };
      if (response.toolCalls) {
        assistantMsg.tool_calls = response.toolCalls;
      }
      this.chatHistory.push(assistantMsg);
      this.recordTranscript(assistantMsg);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        finalAnswer = response.content;
        break;
      }

      // Execute tool calls chosen by the LLM
      for (const tc of response.toolCalls) {
        const name = tc.function.name;
        let args: any = {};
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch (e) {
          // Fallback if parsing fails
        }

        const isLocal = LOCAL_TOOLS.some(lt => lt.name === name);
        callbacks.onToolStart(name, args);

        let resultText = '';
        let isError = false;
        let summary = '';

        try {
          if (!allowed.has(name) && isLocal) {
            throw new Error(`Tool "${name}" is not permitted in access mode "${this.accessMode}".`);
          }
          if (isOrchestrationToolName(name)) {
            resultText = await executeOrchestrationTool(name, args, {
              workspaceRoot: this.workspaceRoot,
              parentSessionKey: this.sessionKey,
              mcpClient: this.mcpClient,
              llmConfig: this.llmConfig,
              launchCwd: this.launchCwd,
            });
            summary = getToolSummary(name, args, resultText);
          } else if (isLocal) {
            resultText = await this.executeLocalTool(name, args);
            summary = getToolSummary(name, args, resultText);
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
          resultText = `Tool execution failed: ${err.message}`;
          summary = err.message;
        }

        callbacks.onToolEnd(name, { success: !isError, summary });

        const toolMsg = {
          role: 'tool',
          tool_call_id: tc.id,
          name: name,
          content: resultText,
          isError
        };
        this.chatHistory.push(toolMsg);
        this.recordTranscript(toolMsg);
      }
    }

    await this.captureTurn(prompt, finalAnswer);
    return finalAnswer || 'I could not produce a final answer before the tool loop limit was reached.';
  }

  private async executeLocalTool(name: string, args: Record<string, any>): Promise<string> {
    switch (name) {
      case 'read_file': {
        const resolved = resolveWorkspacePath(args.path);
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
        const resolved = resolveWorkspacePath(args.path, { forWrite: true });
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, args.content, 'utf8');
        return `Successfully wrote file: ${args.path}`;
      }
      case 'edit_file': {
        const resolved = resolveWorkspacePath(args.path);
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
        const targetDir = resolveWorkspacePath(args.path || '.');
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
        const root = resolveWorkspacePath(args.path || '.');
        const results: Array<{ path: string; line: number; text: string }> = [];
        
        const search = (dir: string) => {
          if (results.length >= 50) return;
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (IGNORED_DIRS.has(file)) continue;
            const full = path.join(dir, file);
            if (!isPathInside(getWorkspaceRoot(), fs.realpathSync(full))) continue;
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
                      path: path.relative(process.cwd(), full),
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
        const matches = globFiles(pattern);
        return JSON.stringify(matches, null, 2);
      }
      case 'run_command': {
        const cmd = args.command;
        if (this.accessMode !== 'shell') {
          return `Command execution denied: agent access mode is "${this.accessMode}".`;
        }
        if (!this.silent) {
          console.log(`\n${chalk.yellow('⚠️  Command execution request:')} ${chalk.cyan(cmd)}`);
          const answers = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'approve',
              message: 'Allow execution?',
              default: false
            }
          ]);
          if (!answers.approve) {
            return 'Command execution rejected by user.';
          }
        }

        try {
          const { stdout, stderr } = await execPromise(cmd);
          return `Exit Code: 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
        } catch (err: any) {
          return `Exit Code: ${err.code ?? 1}\nSTDOUT:\n${err.stdout ?? ''}\nSTDERR:\n${err.stderr ?? err.message}`;
        }
      }
      case 'fetch_url': {
        const url = args.url;
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; BrainRouterCLI/0.2.0)'
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
      case 'update_plan': {
        const state = updatePlan(this.workspaceRoot, {
          explanation: args.explanation,
          plan: args.plan,
        });
        return formatPlan(state);
      }
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }

  clearHistory() {
    this.chatHistory = [this.createSystemMessage()];
    this.initialized = true;
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

  private createSystemMessage() {
    const base = this.systemPromptOverride ?? buildSystemPrompt({
      workspaceRoot: this.workspaceRoot,
      launchCwd: this.launchCwd,
      sessionKey: this.sessionKey,
      instructionSummary: loadWorkspaceInstructionSummary(this.workspaceRoot),
    });
    const content = this.roleOverlay ? `${base}\n\n${this.roleOverlay}` : base;
    return { role: 'system', content };
  }

  private async injectRecallContext(prompt: string, mcpTools: any[], callbacks: RunTurnCallbacks): Promise<void> {
    if (!this.enableRecall) {
      this.recalledRecords = [];
      this.recalledRecordIds = [];
      this.lastBriefingSources = [];
      return;
    }

    callbacks.onStatusUpdate('Briefing from BrainRouter memory...');
    const briefing = await buildMemoryBriefing({
      mcpClient: this.mcpClient,
      mcpTools,
      sessionKey: this.sessionKey,
      workspaceRoot: this.workspaceRoot,
      query: prompt,
    });

    this.recalledRecords = briefing.recalledRecords;
    this.recalledRecordIds = briefing.recalledRecordIds;
    this.lastBriefingSources = briefing.sourcesQueried;

    if (briefing.block) {
      this.chatHistory.push({ role: 'system', content: briefing.block });
      callbacks.onStatusUpdate(
        `Memory briefing loaded: ${briefing.sourcesQueried.join(', ')} (${briefing.recalledRecordIds.length} records).`,
      );
    }
  }

  /** Inspectable summary of the most recent memory briefing. Used by the `/briefing` slash command. */
  public getLastBriefing(): { sources: string[]; recordIds: string[] } {
    return { sources: [...this.lastBriefingSources], recordIds: [...this.recalledRecordIds] };
  }

  /** One-line summary of any new contradiction surfaced after the last capture, or undefined if none. */
  private lastContradictionWarning?: string;
  public takeContradictionWarning(): string | undefined {
    const w = this.lastContradictionWarning;
    this.lastContradictionWarning = undefined;
    return w;
  }

  private async checkContradictions(): Promise<void> {
    if (!this.enableRecall) return;
    const res = await callMcpTool<any>(this.mcpClient, 'memory_contradictions', { action: 'list' });
    if (res.isError || !res.parsed) return;
    const list = res.parsed?.contradictions ?? res.parsed?.items ?? res.parsed;
    if (!Array.isArray(list) || list.length === 0) return;
    const first = list[0];
    const summary = first?.summary || first?.description || first?.title || JSON.stringify(first).slice(0, 200);
    this.lastContradictionWarning = `${list.length} unresolved contradiction(s). First: ${summary}`;
  }

  private async captureTurn(prompt: string, finalAnswer: string): Promise<void> {
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
      }
    } catch {
      // Citation feedback should not break the user-facing turn.
    }

    try {
      await this.mcpClient.callTool('memory_capture_turn', {
        sessionKey: this.sessionKey,
        messages: [
          { role: 'user', content: prompt, timestamp },
          { role: 'assistant', content: finalAnswer, timestamp: Date.now() },
        ],
      });
    } catch {
      // Passive capture is best effort in the CLI.
    }

    await this.checkContradictions();
  }

  private recordTranscript(message: any): void {
    try {
      appendTranscriptEntry(this.workspaceRoot, this.sessionKey, message);
    } catch {
      // Transcript persistence should not break the interactive turn.
    }
  }
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

export function globFiles(pattern: string, dir = getWorkspaceRoot()): string[] {
  const safeDir = resolveWorkspacePath(path.relative(getWorkspaceRoot(), dir) || '.');
  const results: string[] = [];
  const items = fs.readdirSync(safeDir);
  for (const item of items) {
    if (IGNORED_DIRS.has(item)) {
      continue;
    }
    const fullPath = path.join(safeDir, item);
    if (!isPathInside(getWorkspaceRoot(), fs.realpathSync(fullPath))) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...globFiles(pattern, fullPath));
    } else if (stat.isFile()) {
      const relPath = path.relative(process.cwd(), fullPath);
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

export function buildChatCompletionPayload(config: LLMConfig, messages: any[], tools: any[]): ChatCompletionPayload {
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
      content: m.content
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

  return body;
}

async function callOpenAI(config: LLMConfig, messages: any[], tools: any[]) {
  const endpoint = config.endpoint || 'https://api.openai.com/v1';
  let apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
  const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
  if (!apiKey && !isLocal) {
    throw new Error('LLM API key is required for OpenAI provider.');
  }
  if (!apiKey && isLocal) {
    apiKey = 'sk-local-placeholder';
  }

  const body = buildChatCompletionPayload(config, messages, tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const timeoutMs = Number(process.env.BRAINROUTER_LLM_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${timeoutMs}ms. Check that ${endpoint} is running and that model "${config.model}" can answer chat/completions requests with tools enabled.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${res.statusText} - ${errText}`);
  }

  const data = await res.json() as any;
  const choice = data.choices[0];
  if (!choice?.message) {
    throw new Error(`OpenAI-compatible endpoint returned an invalid chat completion response: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return {
    content: choice.message.content || '',
    toolCalls: choice.message.tool_calls
  };
}
