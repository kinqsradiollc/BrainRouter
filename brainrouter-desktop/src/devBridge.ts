/**
 * DESK-4c — browser-dev mock bridge. In Electron the preload provides
 * `window.brainrouter`; in a plain browser (vite dev / UI work without the
 * shell) this installs a canned stand-in so every surface renders populated:
 * demo sessions, files, diff, plan, fleet, tokens, settings snapshot, the
 * command catalog, an echo turn with a tool group, and an approval dialog
 * when the prompt mentions "approve". No-op when the real bridge exists.
 */
import type { AgentCommand, AgentEvent, AgentEventMessage } from '@kinqs/brainrouter-agent-protocol';

export function installDevBridge(): void {
  if (typeof window === 'undefined' || (window as { brainrouter?: unknown }).brainrouter) return;

  const listeners = new Set<(msg: AgentEventMessage) => void>();
  let seq = 0;
  const emit = (event: AgentEvent, delay = 0) => {
    setTimeout(() => {
      const msg: AgentEventMessage = { seq: ++seq, ts: Date.now(), sessionKey: 'dev:demo', event };
      listeners.forEach((l) => l(msg));
    }, delay);
  };

  const DEMO_DIFF = [
    'diff --git a/src/agent/agent.ts b/src/agent/agent.ts',
    '--- a/src/agent/agent.ts',
    '+++ b/src/agent/agent.ts',
    '@@ -1240,6 +1240,9 @@ export class Agent {',
    '   private mutatedThisTurn = false;',
    '   private verifiedThisTurn = false;',
    '+  // DESK-2 — cooperative turn interrupt, checked at every boundary.',
    '+  private interruptRequested = false;',
    '+',
    '   constructor(mcp: McpClientPool, llm: LlmConfig) {',
  ].join('\n');

  const prefs = {
    executionMode: 'planning', reviewPolicy: 'request', delegationPolicy: 'auto', autoChain: 'off',
    effort: 'medium', personality: 'standard', tier: null, theme: 'dark', quiet: false,
    memoriesEnabled: true, personaAnchorEnabled: true, experimental: false, rawScrollback: false, editorMode: 'emacs',
  } as Record<string, unknown>;

  const queries: Record<string, (args: Record<string, unknown>) => unknown> = {
    'list-sessions': () => [
      { sessionKey: 'dev:fix-recall-blend', firstUserMessage: 'fix the reranker blend regression' },
      { sessionKey: 'dev:grid-tui', firstUserMessage: 'make the sidebar live' },
      { sessionKey: 'dev:release-0414', firstUserMessage: 'release 0.4.14 to npm' },
    ],
    'fleet': () => [
      { kind: 'sub-agent', id: 'agent-3f2a', label: 'explorer·3f2a — survey recall pipeline' },
      { kind: 'worker', id: 'wkr-91', label: 'worker·91 ⎇ — vitest suite' },
    ],
    'session-info': () => ({ sessionKey: 'dev:demo', model: 'claude-opus-4-8', workspaceRoot: '/Users/dev/BrainRouter' }),
    'changed-files': () => [
      { status: 'M', path: 'src/agent/agent.ts' },
      { status: 'M', path: 'src/cli/ink/ChatApp.tsx' },
      { status: 'A', path: 'src/state/completionInbox.ts' },
      { status: '??', path: 'notes/scratch.md' },
    ],
    'list-files': () => ({
      files: [
        'package.json', 'README.md', 'src/agent/agent.ts', 'src/agent/tools/registry.ts',
        'src/cli/ink/ChatApp.tsx', 'src/cli/ink/components/Sidebar.tsx', 'src/cli/repl.ts',
        'src/config/config.ts', 'src/runtime/mcpPool.ts', 'src/state/completionInbox.ts',
        'src/state/sessionStore.ts', 'src/tests/interrupt.test.ts',
      ],
      truncated: false,
    }),
    'git-info': () => ({ repo: 'BrainRouter', branch: 'release/0.4.15', files: 4, insertions: 7670, deletions: 112 }),
    'file-diff': (a) => ({ path: String(a.path ?? 'src/agent/agent.ts'), diff: DEMO_DIFF }),
    'read-file': (a) => ({
      path: String(a.path ?? 'src/state/completionInbox.ts'),
      content: [
        '/** Completion inbox — detached workers report back here. */',
        "import { randomUUID } from 'node:crypto';",
        '',
        'export interface Completion {',
        '  id: string;',
        '  parentSessionKey: string;',
        '  summary: string;',
        '}',
        ...Array.from({ length: 20 }, (_, i) => `// line ${i + 9}`),
      ].join('\n'),
    }),
    'commands-catalog': () => ({
      categories: [
        { key: 'session', title: 'Session & State', entries: [
          { cmd: '/new [label]', desc: 'Start a new chat with a fresh session key' },
          { cmd: '/clear', desc: 'Clear chat history for the active session' },
          { cmd: '/compact', desc: 'LLM-driven compaction of the active session' },
          { cmd: '/resume <id>', desc: 'Resume a previous session by sessionKey' },
          { cmd: '/find <query>', desc: 'Search this session transcript' },
          { cmd: '/recap', desc: 'Instant summary of this session' },
          { cmd: '/chapters', desc: 'Table of contents from chapter markers' },
          { cmd: '/export-chat [md|json]', desc: 'Export this session transcript to a file' },
        ] },
        { key: 'guard', title: 'Guardrails & Permissions', entries: [
          { cmd: '/permissions [read|write|shell]', desc: 'View or set agent access mode' },
          { cmd: '/mode [planning|fast]', desc: 'Session execution stance' },
          { cmd: '/yolo [on|off]', desc: 'Fast mode + proceed review policy' },
          { cmd: '/hooks [list|add|remove]', desc: 'Lifecycle shell hooks' },
        ] },
        { key: 'obs', title: 'Observability', entries: [
          { cmd: '/usage', desc: 'Per-actor token breakdown' },
          { cmd: '/tokens', desc: 'Session token usage' },
          { cmd: '/context [all|current]', desc: 'Context-window fill' },
        ] },
        { key: 'workflow', title: 'Workflows & Skills', entries: [
          { cmd: '/review [scope] [--fix]', desc: 'Multi-agent code review' },
          { cmd: '/goal [text|clear]', desc: 'Sticky goal' },
          { cmd: '/plan', desc: 'Show the durable CLI task plan' },
          { cmd: '/diff', desc: 'Show git changes' },
        ] },
      ],
      all: ['/help', '/status', '/model', '/mcp', '/theme', '/vim', '/spawn', '/bg', '/workers', '/ps'],
    }),
    'config-snapshot': () => ({
      model: 'claude-opus-4-8', provider: 'anthropic', fallbackModel: null,
      workspaceRoot: '/Users/dev/BrainRouter', sandbox: 'off', prefs: { ...prefs },
      permissionRules: { allow: ['run_command(git *)', 'run_command(npm test*)'], deny: ['run_command(rm -rf *)'] },
      hooks: [
        { id: 'h1', event: 'pre-tool', command: './hooks/guard-prod.sh', enabled: true, match: 'run_command' },
        { id: 'h2', event: 'user-prompt-submit', command: './hooks/inject-ticket.sh', enabled: false },
      ],
      servers: [{ id: 'brainrouter', online: true }, { id: 'github', online: false }],
    }),
    'usage-breakdown': () => [
      'parent      48,213 in · 1,904 out · cache hit 92%',
      'explorer·3f2a   12,408 in · 822 out',
      'worker·91        8,114 in · 1,201 out',
      'TOTAL       68,735 in · 3,927 out',
      'offload: 31% of parent context avoided via child agents',
    ],
    'search-transcript': (a) => [
      { index: 3, role: 'assistant', snippet: `…the reranker ${String(a.q ?? 'blend')} replaces the retriever order — fix is a weighted blend…` },
      { index: 7, role: 'user', snippet: `…can you re-run the sweep after the ${String(a.q ?? 'blend')} change…` },
    ],
    'chapters': () => [
      { title: 'Reproduce the regression', summary: '6-split sweep, MemBench drop isolated' },
      { title: 'Patch the blend scoring', summary: '0.6·rerank + 0.4·rrf' },
    ],
    'export-chat': () => ({ filename: 'dev-demo.md', content: '# BrainRouter session transcript\n\n- Session: dev:demo\n\n…' }),
    'recap': () => ['Last prompt: fix the reranker blend regression', 'Files touched: src/memory/recall.ts', 'Open plan: 2/3 done'],
    'action:clear': () => ({ ok: true }),
    'action:compact': () => ({ summary: 'Early exploration compacted; kept the blend fix decision and the sweep numbers.', estimatedTokens: 412, durationMs: 1830, replacedMessages: 14 }),
    'action:set-pref': (a) => { prefs[String(a.key)] = a.value; return { ...prefs }; },
    'action:set-hook': () => ({ ok: true }),
    'action:set-access': (a) => ({ ok: true, mode: a.mode }),
    'action:reconnect-mcp': () => ({ ok: true }),
  };

  (window as unknown as { brainrouter: unknown }).brainrouter = {
    send(command: AgentCommand): void {
      switch (command.kind) {
        case 'query': {
          const handler = queries[command.name];
          if (handler) emit({ kind: 'query-result', id: command.id, ok: true, result: handler(command.args ?? {}) }, 30);
          else emit({ kind: 'query-result', id: command.id, ok: false, error: `Unknown query "${command.name}" (dev bridge)` }, 30);
          return;
        }
        case 'start-turn': {
          const wantsApproval = command.prompt.toLowerCase().includes('approve');
          emit({ kind: 'status', text: 'Reading the workspace…' }, 100);
          emit({ kind: 'tool-end', tool: 'grep_search', ok: true, summary: '14 hits in 6 files' }, 500);
          emit({ kind: 'tool-end', tool: 'read_file', ok: true, summary: 'src/agent/agent.ts (220 lines)', preview: 'export class Agent {\n  // …\n}' }, 900);
          emit({ kind: 'tool-end', tool: 'run_command', ok: true, summary: 'npm test', preview: '# tests 1387\n# pass 1387\n# fail 0' }, 1400);
          if (wantsApproval) {
            emit({ kind: 'interaction-request', request: { id: 'ir_demo', type: 'confirm', title: 'Run shell command?', detail: 'git push origin release/0.4.15', dangerous: true, tool: 'run_command' } }, 1800);
          }
          emit({ kind: 'plan-update', items: [
            { step: 'Reproduce the failing case', status: 'completed' },
            { step: 'Patch the blend scoring', status: 'in_progress' },
            { step: 'Re-run the 6-split sweep', status: 'pending' },
          ] }, 1900);
          emit({ kind: 'assistant-turn-start' }, 2100);
          const answer = `Here's what I found in the workspace:\n\n- The recall blend lives in \`src/memory/recall.ts\` and the reranker score **replaces** the retriever order.\n- Fix: blend with the recency/RRF score instead — *score → sort → take top-N, never hard-drop*.\n\n\`\`\`ts\nconst blended = 0.6 * rerank + 0.4 * rrf;\n\`\`\`\n\n| split | before | after |\n|---|---|---|\n| MemBench | 0.41 | **0.58** |\n| LoCoMo | 0.37 | **0.52** |`;
          answer.split(/(?<=\s)/).forEach((chunk, i) => emit({ kind: 'assistant-delta', text: chunk }, 2200 + i * 18));
          const end = 2200 + answer.split(/(?<=\s)/).length * 18 + 200;
          emit({ kind: 'assistant-turn-end' }, end);
          emit({ kind: 'turn-complete', answer }, end + 80);
          emit({ kind: 'tokens-updated', promptTokens: 48_213, completionTokens: 1_904, calls: 6, turns: 3 }, end + 120);
          return;
        }
        case 'interaction-response':
          emit({ kind: 'status', text: 'Approval received (demo).' }, 50);
          return;
        case 'new-session':
          emit({ kind: 'session-changed', sessionKey: 'dev:new-chat', loadedMessages: 0, model: 'claude-opus-4-8' }, 60);
          return;
        case 'resume-session':
          emit({ kind: 'session-changed', sessionKey: (command as { sessionKey: string }).sessionKey, loadedMessages: 12, model: 'claude-opus-4-8' }, 60);
          return;
        case 'set-model':
          emit({ kind: 'status', text: `Model set to ${(command as { model: string }).model} (saved to config.json — shared with the CLI).` }, 60);
          emit({ kind: 'session-changed', sessionKey: 'dev:demo', loadedMessages: -1, model: (command as { model: string }).model }, 80);
          return;
        case 'interrupt':
          emit({ kind: 'status', text: 'Interrupt requested.' }, 30);
          emit({ kind: 'turn-error', message: 'Turn interrupted by user.' }, 200);
          return;
        default: return;
      }
    },
    onEvent(listener: (msg: AgentEventMessage) => void): () => void {
      listeners.add(listener);
      emit({ kind: 'status', text: 'Dev bridge online (browser preview — no Electron).' }, 50);
      return () => listeners.delete(listener);
    },
    addWorkspace: async () => ({ opened: false }),
    workspaceRecents: async () => ({ current: '/Users/dev/BrainRouter', recents: ['/Users/dev/BrainRouter', '/Users/dev/side-project'] }),
    openWorkspace: async () => ({ opened: false }),
  };
}
