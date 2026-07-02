import type { Command } from 'commander';
import { loadConfig, getCliKnobs, setCliKnobOverride, type LLMConfig } from '@kinqs/brainrouter-core/config';
import { resolveSessionLlmConfig } from '@kinqs/brainrouter-core/session';
import { McpClientPool, selectMcpServerIds } from '@kinqs/brainrouter-core/mcp';
import { formatJsonlEvent, memoryRunEvent, isOffloadTool, type RunEvent } from '../runtime/jsonlEvents.js';
import { costUsd } from '../runtime/pricing.js';
import { setKnownMcpServerIds } from '../cli/ink/toolFormat.js';
import type { ServerConfig } from '@kinqs/brainrouter-core/config';
import { Agent } from '@kinqs/brainrouter-core/agent';
import { cliPrompter } from '../cli/cliPrompt.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { DEFAULT_LLM } from './shared.js';

export function registerRunCommand(program: Command): void {
  // One-shot non-interactive run — pipe-friendly for scripting/CI.
  //   brainrouter run "summarize the changes in src/"
  //   echo "what is this repo?" | brainrouter run -
  //   brainrouter run --print "..."        → print answer only
  //   brainrouter run --json "..."         → JSON-line with answer + usage
  program
    .command('run [prompt...]')
    .description('Run a single agent turn non-interactively and print the answer (use "-" to read prompt from stdin)')
    .option('-p, --profile <name>', 'Connection profile name')
    .option('-m, --model <name>', 'LLM model override')
    .option('-w, --workspace <path>', 'Workspace root')
    .option('--print', 'Print the answer text only, no chrome')
    .option('--json', 'Emit one JSON line { answer, usage, durationMs, sessionKey }')
    .option('--format <fmt>', 'Output format: text (default) | json | jsonl (stable per-event stream for CI)')
    .option('--session <key>', 'Resume a specific sessionKey')
    .option('--timeout <ms>', 'LLM request timeout in ms')
    .option('--max-tool-loops <n>', 'Hard cap on tool iterations for this run (CI guard)')
    .option('--disallowed-tools <names>', 'Comma-separated tool names denied for this run (any tool, local or MCP)')
    .option('--strict-mcp', 'Exit if the MCP server is unreachable (default: continue in offline mode with local tools only)')
    .action(async (promptParts: string[], options) => {
      if (options.workspace) setCliKnobOverride({ workspaceOverride: options.workspace });
      // CC-P13.2 — headless automation guards.
      if (options.maxToolLoops) {
        const n = Number(options.maxToolLoops);
        if (Number.isFinite(n) && n > 0) setCliKnobOverride({ maxToolLoops: Math.floor(n) });
      }
      if (options.disallowedTools) {
        const { parseToolList } = await import('@kinqs/brainrouter-core/exec');
        const denied = parseToolList(String(options.disallowedTools));
        if (denied.length > 0) {
          const current = getCliKnobs().permissions;
          setCliKnobOverride({ permissions: { allow: current.allow, deny: [...current.deny, ...denied] } });
        }
      }
      if (options.timeout) {
        const ms = Number(options.timeout);
        if (Number.isFinite(ms) && ms > 0) setCliKnobOverride({ llmTimeoutMs: ms });
      }

      let prompt = (promptParts ?? []).join(' ').trim();
      if (prompt === '-' || !prompt) {
        // Read from stdin
        prompt = await new Promise<string>((resolve) => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => { buf += chunk; });
          process.stdin.on('end', () => resolve(buf.trim()));
        });
      }
      if (!prompt) {
        console.error('Error: no prompt provided (pass as args or via stdin).');
        process.exit(2);
      }

      // Reject slash commands in headless mode. The REPL handles them via
      // handleSlashCommand, but `run` skips straight to agent.runTurn — so a
      // user piping `/help` or `/sessions` was silently routed to the LLM and
      // got back a confused chat response instead of a real CLI error.
      // Headless mode now exits with a real error instead of consuming a turn.
      if (prompt.startsWith('/')) {
        const cmdName = prompt.split(/\s+/)[0];
        console.error(
          `Error: slash commands are not supported in 'run' (headless) mode. ` +
          `"${cmdName}" must be invoked from the interactive REPL (run \`brainrouter\` with no args).`,
        );
        console.error(`Hint: if you meant to send "${cmdName}" as a literal prompt, escape it with a leading space.`);
        process.exit(2);
      }

      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);

      const config = loadConfig();
      // Multi-MCP: like `chat`, connect third-party servers concurrently but
      // only one BrainRouter MCP profile at a time. `--profile <name>` scopes
      // to exactly one.
      const requestedProfile = options.profile as string | undefined;
      const allServerIds = Object.keys(config.servers);
      if (allServerIds.length === 0) {
        console.error('Error: No MCP server profiles in config.');
        process.exit(1);
      }
      if (requestedProfile && !config.servers[requestedProfile]) {
        console.error(`Error: Profile "${requestedProfile}" not found.`);
        process.exit(1);
      }
      const targetIds = selectMcpServerIds(config.servers, config.activeServer, requestedProfile);
      const targetServers: Record<string, ServerConfig> = {};
      for (const id of targetIds) {
        const cloned = { ...config.servers[id] };
        if (cloned.type === 'stdio') {
          const args = cloned.args ?? [];
          const rootIndex = args.indexOf('--root');
          cloned.args = rootIndex >= 0
            ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
            : [...args, '--root', workspace.workspaceRoot];
        }
        targetServers[id] = cloned;
      }

      let llm: LLMConfig = { ...(config.llm ?? DEFAULT_LLM) };
      if (options.model) llm.model = options.model;
      else if (options.session) llm = resolveSessionLlmConfig(llm, workspace.workspaceRoot, options.session);

      const mcpClient = new McpClientPool();
      const statuses = await mcpClient.connectAll(targetServers, llm, { timeoutMs: 5_000 });
      mcpClient.startReconnectSupervisor(); // WS9 — auto-reconnect dropped MCP servers in the background
      // Register live server ids for Ink tool-name display so multi-word
      // server names (e.g. `my_server`) don't get mis-stripped by the
      // single-underscore prefix regex.
      setKnownMcpServerIds(mcpClient.getServerIds());
      const allFailed = statuses.length > 0 && statuses.every((s) => s.status === 'failed');
      if (allFailed) {
        const summary = statuses.map((s) => `${s.serverId}: ${s.error ?? 'unknown'}`).join('; ');
        console.error(`MCP connect failed (all servers): ${summary}`);
        if (options.strictMcp) process.exit(1);
        // Offline mode for one-shot: same rationale as the chat command — local
        // tools still work, MCP-backed calls return error envelopes the agent
        // already tolerates. Useful when piping a quick "read this file and
        // summarize" while the MCP server is down. CI can pass --strict-mcp.
        console.error('Continuing in offline mode (no memory recall / skills). Pass --strict-mcp to exit instead.');
      } else {
        const failed = statuses.filter((s) => s.status === 'failed');
        if (failed.length > 0) {
          process.stderr.write(`[mcp] ${failed.length} of ${statuses.length} servers offline: ${failed.map((f) => f.serverId).join(', ')}\n`);
        }
      }

      const agent = new Agent(mcpClient, llm, {
        workspaceRoot: workspace.workspaceRoot,
        launchCwd: workspace.launchCwd,
        sessionKey: options.session,
        prompter: cliPrompter,
      });

      // CLI-7 — output format: text (default) | json (single line) | jsonl (per-event stream).
      const fmt: 'text' | 'json' | 'jsonl' =
        options.format === 'jsonl' ? 'jsonl'
        : options.format === 'json' || options.json ? 'json'
        : options.format === 'text' || options.format === undefined ? 'text'
        : 'text';
      if (options.format && !['text', 'json', 'jsonl'].includes(options.format)) {
        console.error(`Error: --format must be text | json | jsonl (got "${options.format}").`);
        await mcpClient.close();
        process.exit(2);
      }
      const emit = (ev: RunEvent): void => {
        if (fmt === 'jsonl') process.stdout.write(formatJsonlEvent(ev, new Date().toISOString()) + '\n');
      };

      const startedAt = Date.now();
      let answer = '';
      emit({ type: 'turn_start', sessionKey: agent.sessionKey, prompt });
      try {
        answer = await agent.runTurn(prompt, {
          onStatusUpdate: (message) => emit({ type: 'status', message }),
          onToolStart: (name) => { emit({ type: 'tool_start', name }); if (fmt === 'text' && !options.print) process.stderr.write(`  · ${name}\n`); },
          onToolEnd: (name, result) => {
            emit({ type: 'tool_end', name, ok: result.success, summary: result.summary });
            // HEADLESS-EVENTS — a completed offload also gets a dedicated event.
            if (isOffloadTool(name)) emit({ type: 'offload', tool: name, ok: result.success, summary: result.summary });
          },
          onChildToolStart: (e) => emit({ type: 'child_tool', childId: e.childId, role: e.role, tool: e.tool }),
          onChildToolEnd: (e) => emit({ type: 'child_tool', childId: e.childId, role: e.role, tool: e.tool, ok: e.ok, summary: e.summary }),
          onChildComplete: (e) => emit({ type: 'child_complete', childId: e.childId, role: e.role, status: e.status, error: e.error, worktree: e.worktree }),
          // HEADLESS-EVENTS (0.4.5) — richer taxonomy for jsonl consumers.
          onMemoryEvent: (e) => { const ev = memoryRunEvent(e as any); if (ev) emit(ev); },
          onApproval: (e) => emit({ type: 'approval', tool: e.tool, action: e.action, decision: e.decision, reason: e.reason }),
          onUsageUpdate: (u) => emit({
            type: 'cost_update',
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            calls: u.calls,
            cachedTokens: u.cachedTokens,
            missedTokens: u.missedTokens,
            costUsd: costUsd(agent.getModel(), { cachedTokens: u.cachedTokens ?? 0, missedTokens: u.missedTokens ?? 0, completionTokens: u.completionTokens }),
          }),
          onCodeIndex: (e) => emit({ type: 'code_index', file: e.file, status: 'reindexed', chunks: e.chunks }),
        });
      } catch (err: any) {
        emit({ type: 'error', message: err?.message ?? String(err) });
        if (fmt !== 'jsonl') console.error(`run failed: ${err.message}`);
        await mcpClient.close();
        process.exit(1);
      }
      const durationMs = Date.now() - startedAt;
      await mcpClient.close();

      const u = agent.lastTurnUsage;
      if (fmt === 'jsonl') {
        emit({ type: 'text', text: answer });
        emit({
          type: 'turn_end',
          sessionKey: agent.sessionKey,
          durationMs,
          usage: u,
          costUsd: costUsd(agent.getModel(), { cachedTokens: u.cachedTokens, missedTokens: u.missedTokens, completionTokens: u.completionTokens }),
        });
      } else if (fmt === 'json') {
        process.stdout.write(JSON.stringify({
          answer,
          sessionKey: agent.sessionKey,
          usage: u,
          durationMs,
        }) + '\n');
      } else {
        process.stdout.write(answer + (answer.endsWith('\n') ? '' : '\n'));
        if (!options.print) {
          process.stderr.write(`\n[done · ${Math.round(durationMs / 1000)}s · ${u.promptTokens} in / ${u.completionTokens} out across ${u.calls} call${u.calls === 1 ? '' : 's'}]\n`);
        }
      }
      process.exit(0);
    });
}
