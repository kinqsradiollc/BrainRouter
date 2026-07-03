// Tool-result presentation helpers — split out of agent.ts (god-file breakdown).
// Byte-identical moves: getToolSummary / getToolPreview render human-readable
// one-liners + previews for tool outputs; formatBytes is their shared helper.
// Pure functions, no Agent-instance state.

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
    case 'run_command': {
      // Surface the COMMAND itself — that's the meaningful, scannable part. The
      // ✓/✕ status indicator + the output preview already convey the outcome, so
      // we only append the exit code when it's non-zero (a failure worth seeing).
      const cmd = typeof args.command === 'string' ? args.command.trim().split('\n')[0].slice(0, 160) : '';
      if (result.includes('rejected by user')) return cmd ? `rejected: ${cmd}` : 'execution rejected by user';
      const code = result.match(/Exit Code: (\d+)/)?.[1] ?? '0';
      if (!cmd) return `exited with code ${code}`;
      return code === '0' ? cmd : `${cmd} — exit ${code}`;
    }
    case 'fetch_url':
      if (result.startsWith('Failed')) {
        return 'failed web fetch';
      }
      return `fetched content from ${args.url}`;
    case 'web_search':
      try { return `${JSON.parse(result).length} web results for "${args.query}"`; } catch { return `searched web for "${args.query}"`; }
    case 'list_mcp_resources':
      try { return `${JSON.parse(result).resources?.length ?? 0} MCP resources`; } catch { return 'listed MCP resources'; }
    case 'list_mcp_resource_templates':
      try { return `${JSON.parse(result).resourceTemplates?.length ?? 0} MCP resource templates`; } catch { return 'listed MCP resource templates'; }
    case 'read_mcp_resource':
      return `read MCP resource ${args.server}:${args.uri}`;
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
    case 'send_input':
      return `sent input to agent ${args.id}`;
    case 'resume_agent':
      return `resumed agent ${args.id}`;
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
