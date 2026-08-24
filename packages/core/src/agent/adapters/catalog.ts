import fs from 'node:fs';
import path from 'node:path';
import type { AdapterDetection, AgentAdapter, AgentAdapterId } from './types.js';

const common = {
  controls: { interrupt: '\u0003', approve: 'y\r', submit: '\r' },
  statusPatterns: {
    blocked: [/approve/i, /permission/i, /allow .+\?/i, /continue\?/i],
    waiting: [/(?:^|\n)\s*[>$❯]\s*$/m, /what would you like/i, /ready for/i],
    done: [/task complete/i, /completed successfully/i],
    failed: [/fatal:/i, /authentication failed/i, /command not found/i],
  },
};

export const AGENT_ADAPTERS: readonly AgentAdapter[] = [
  {
    id: 'brainrouter', label: 'BrainRouter', command: 'brainrouter', aliases: [],
    interactiveArgs: ['chat'], resumeArgs: (id) => ['chat', '--resume', id],
    requiresWorkspaceTrust: false, ...common,
    integration: { hookEvents: ['pre-tool', 'post-tool', 'stop', 'notification-agent-needs-input', 'notification-agent-completed'] },
  },
  {
    id: 'claude-code', label: 'Claude Code', command: 'claude', aliases: [],
    // ADR-047 D2 — headless: `claude -p` (print mode) reads the prompt from stdin.
    interactiveArgs: [], engineArgs: ['-p'], resumeArgs: (id) => ['--resume', id],
    requiresWorkspaceTrust: true, ...common,
    integration: {
      mcp: { command: 'claude', args: ['mcp', 'add', '--scope', 'local', 'brainrouter', '--', 'brainrouter', 'mcp-proxy'] },
      hookEvents: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'],
    },
  },
  {
    id: 'codex', label: 'Codex CLI', command: 'codex', aliases: [],
    // ADR-047 D2 — headless: `codex exec` runs a single non-interactive turn (prompt on stdin).
    interactiveArgs: [], engineArgs: ['exec'], resumeArgs: (id) => ['resume', id],
    requiresWorkspaceTrust: true, ...common,
    integration: {
      mcp: { command: 'codex', args: ['mcp', 'add', 'brainrouter', '--', 'brainrouter', 'mcp-proxy'] },
      hookEvents: ['session-start', 'turn-start', 'tool-start', 'tool-end', 'approval', 'turn-complete'],
    },
  },
  {
    id: 'opencode', label: 'OpenCode', command: 'opencode', aliases: [],
    // ADR-047 D2 — headless: `opencode run "<prompt>"` (prompt as an arg).
    interactiveArgs: [], engineArgs: ['run', '{prompt}'], resumeArgs: (id) => ['--session', id],
    requiresWorkspaceTrust: true, ...common,
    integration: {
      hookEvents: ['session.created', 'session.status', 'tool.execute.before', 'tool.execute.after', 'session.idle', 'session.error'],
    },
  },
  {
    id: 'gemini-cli', label: 'Gemini CLI', command: 'gemini', aliases: [],
    // ADR-047 D2 — headless: `gemini -p "<prompt>"` (non-interactive, prompt as an arg).
    interactiveArgs: [], engineArgs: ['-p', '{prompt}'], resumeArgs: (id) => ['--resume', id],
    requiresWorkspaceTrust: true, ...common,
    integration: {
      mcp: { command: 'gemini', args: ['mcp', 'add', '--scope', 'user', 'brainrouter', 'brainrouter', 'mcp-proxy'] },
      hookEvents: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'Notification', 'AfterAgent', 'SessionEnd'],
    },
  },
] as const;

export function getAgentAdapter(id: string): AgentAdapter | undefined {
  return AGENT_ADAPTERS.find((adapter) => adapter.id === id);
}

export function findExecutable(command: string, options: { path?: string; platform?: NodeJS.Platform } = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const extensions = platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of (options.path ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, platform === 'win32' ? `${command}${extension.toLowerCase()}` : command);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
      if (platform === 'win32') {
        const upper = path.join(dir, `${command}${extension.toUpperCase()}`);
        try { fs.accessSync(upper, fs.constants.X_OK); return upper; } catch { /* next */ }
      }
    }
  }
  return undefined;
}

export function detectAgentAdapters(options: { path?: string; platform?: NodeJS.Platform } = {}): AdapterDetection[] {
  return AGENT_ADAPTERS.map((adapter) => {
    const executable = [adapter.command, ...adapter.aliases]
      .map((command) => findExecutable(command, options))
      .find(Boolean);
    return { id: adapter.id, installed: !!executable, ...(executable ? { executable } : {}) };
  });
}

export function isAgentAdapterId(value: string): value is AgentAdapterId {
  return AGENT_ADAPTERS.some((adapter) => adapter.id === value);
}
