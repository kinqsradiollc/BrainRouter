/**
 * Tool call display formatters — claude-code-style semantic rendering.
 *
 * The raw `tool_name({"path": "...", ...})` JSON dump that fell out of
 * `agent.runTurn`'s onToolStart callback is hostile to quick scanning
 * during a long turn. claude-code's transcript format is
 *
 *   ⏺ Read(src/auth/login.ts)
 *   ⏺ Bash(npm test)
 *   ⏺ Grep("authenticate")
 *
 * — one-line, identity-revealing, no JSON. These helpers do the same
 * mapping for our built-in LOCAL_TOOLS (cli/../agent/agent.ts) + MCP
 * tool names (which carry an `mcp__<server>__` namespace prefix that
 * the user doesn't care about).
 *
 * Reference for the convention: claude-code transcripts (see
 * openSrc/claude-code/CHANGELOG.md mentions throughout; the format is
 * not formally documented but used in every claude-code session).
 */

/**
 * Format a tool call as a one-line `Function(args)` summary.
 *
 * Examples:
 *   formatToolCall('read_file', { path: 'src/foo.ts' })
 *     → "Read(src/foo.ts)"
 *   formatToolCall('run_command', { command: 'npm test' })
 *     → "Bash(npm test)"
 *   formatToolCall('grep_search', { query: 'authenticate', path: '.' })
 *     → 'Grep("authenticate")'
 *   formatToolCall('mcp__brainrouter__memory_search', { q: 'auth' })
 *     → 'MemorySearch("auth")'
 *   formatToolCall('spawn_agent', { role: 'researcher', prompt: '...' })
 *     → 'Spawn(researcher, "...")'
 *   formatToolCall('task_agent', { role: 'reviewer', prompt: '...' })
 *     → 'Task(reviewer, "...")'
 */
export function formatToolCall(name: string, args: Record<string, any> | undefined): string {
  const safeArgs = args ?? {};
  const clean = stripMcpPrefix(name);

  switch (clean) {
    case 'read_file': {
      const path = safeArgs.path ?? '.';
      const startLine = safeArgs.startLine;
      const endLine = safeArgs.endLine;
      if (startLine && endLine) return `Read(${path}:${startLine}-${endLine})`;
      if (startLine) return `Read(${path}:${startLine})`;
      return `Read(${path})`;
    }
    case 'write_file':
      return `Write(${safeArgs.path ?? ''})`;
    case 'edit_file':
      return `Edit(${safeArgs.path ?? ''})`;
    case 'list_dir':
      return `LS(${safeArgs.path ?? '.'})`;
    case 'grep_search':
      return `Grep(${quoteShort(safeArgs.query, 50)})`;
    case 'glob_files':
      return `Glob(${quoteShort(safeArgs.pattern, 50)})`;
    case 'run_command':
      return `Bash(${truncateOneLine(safeArgs.command ?? '', 70)})`;
    case 'fetch_url':
      return `Fetch(${truncateOneLine(safeArgs.url ?? '', 70)})`;
    case 'web_search':
      return `WebSearch(${quoteShort(safeArgs.query, 50)})`;
    case 'spawn_agent': {
      const role = String(safeArgs.role ?? 'agent');
      const label = safeArgs.label ? ` [${safeArgs.label}]` : '';
      const task = truncateOneLine(safeArgs.prompt ?? '', 50);
      return `Spawn(${role}${label}, "${task}")`;
    }
    case 'task_agent': {
      const role = String(safeArgs.role ?? safeArgs.agentId ?? 'agent');
      const label = safeArgs.label ? ` [${safeArgs.label}]` : '';
      const task = truncateOneLine(safeArgs.prompt ?? '', 50);
      return `Task(${role}${label}, "${task}")`;
    }
    case 'delegate_agent': {
      const role = String(safeArgs.role ?? safeArgs.agentId ?? 'agent');
      const label = safeArgs.label ? ` [${safeArgs.label}]` : '';
      const task = truncateOneLine(safeArgs.prompt ?? '', 50);
      return `Delegate(${role}${label}, "${task}")`;
    }
    case 'spawn_agents': {
      const agents = Array.isArray(safeArgs.agents) ? safeArgs.agents : [];
      const roles = agents.map((a: any) => String(a?.role ?? 'agent')).join(', ');
      return `SpawnAll(${agents.length}: ${roles})`;
    }
    case 'update_plan':
      return `UpdatePlan()`;
    case 'ask_user_choice':
      return `AskUser(${quoteShort(safeArgs.question, 50)})`;
  }

  // Generic fallback: PascalCase the name and surface the first string-shaped
  // argument as the identifying value. Better than JSON-dumping everything.
  const pretty = snakeToPascal(clean);
  const firstString = Object.values(safeArgs).find((v): v is string => typeof v === 'string' && v.length > 0);
  if (firstString !== undefined) {
    return `${pretty}(${truncateOneLine(firstString, 60)})`;
  }
  // No args, or no string args — just show the name.
  return `${pretty}()`;
}

/**
 * Strip the `mcp__<server>__` or `mcp_<server>_` namespace prefix from MCP tool
 * names. Server ids may contain underscores (e.g. `my_server`), so the
 * double-underscore form uses a lazy match. Both prefix conventions are in use
 * across the multi-MCP codepaths until naming is unified.
 *   `mcp__brainrouter__memory_search` → `memory_search`
 *   `mcp__my_server__memory_search`    → `memory_search`
 *   `mcp_brainrouter_memory_search`    → `memory_search`
 */
export function stripMcpPrefix(name: string): string {
  const dbl = name.match(/^mcp__.+?__(.+)$/);
  if (dbl) return dbl[1];
  const sgl = name.match(/^mcp_[^_]+_(.+)$/);
  if (sgl) return sgl[1];
  return name;
}

/**
 * Convert snake_case to PascalCase for readable display names.
 * `memory_search` → `MemorySearch`.
 */
export function snakeToPascal(name: string): string {
  return name
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Quote + truncate a free-form string argument to fit on one line.
 * Returns `""` for missing input — the empty-quote pair signals "empty
 * arg" rather than "no arg" (a no-arg call would not call this at all).
 */
export function quoteShort(s: unknown, max: number): string {
  if (typeof s !== 'string' || s.length === 0) return '""';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  const truncated = oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
  return `"${truncated}"`;
}

/** Collapse whitespace + truncate a string to one line bounded by `max`. */
export function truncateOneLine(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/**
 * Classify a tool-result preview line as part of a unified diff so the
 * renderer can color it (red for removals, green for additions, gray
 * for context). Detects file headers (`+++`, `---`), hunk headers
 * (`@@`), and the per-line +/- gutter sign. Returns undefined when the
 * line doesn't look like diff content so callers can leave it alone.
 */
export function classifyDiffLine(line: string): 'header' | 'hunk' | 'add' | 'del' | 'context' | undefined {
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return undefined;
}

/**
 * True when a multi-line preview looks like a unified diff (at least one
 * `@@` hunk header OR multiple +/- gutter lines). Used by the tool-result
 * renderer to decide whether to apply diff coloring to the whole block.
 */
export function looksLikeDiff(preview: string): boolean {
  if (!preview) return false;
  const lines = preview.split('\n');
  let hunk = false;
  let gutter = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      hunk = true;
      break;
    }
    if (line.startsWith('+') || line.startsWith('-')) gutter++;
    if (gutter >= 2) break;
  }
  return hunk || gutter >= 2;
}
