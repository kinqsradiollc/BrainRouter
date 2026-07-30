/**
 * Maps a tool name to its Codex-style visual: an action verb, a line icon
 * (from the BrainRouter icon set), and a colour tone class. Pure + tested so
 * the chat renderer can show colourful, scannable tool rows instead of a flat
 * monospace strip.
 */
export type ToolTone = 'edit' | 'read' | 'run' | 'search' | 'list' | 'web' | 'agent' | 'memory' | 'default';
export interface ToolVisual {
  verb: string;
  icon: string;
  tone: ToolTone;
}

export type ToolOutcome = 'pending' | 'succeeded' | 'failed';

export function toolVisual(
  tool: string,
  outcome: ToolOutcome = 'succeeded',
  delegationState?: 'accepted' | 'not-started',
): ToolVisual {
  const t = (tool || '').toLowerCase().replace(/^mcp_[a-z0-9]+_/, '');
  const has = (s: string) => t.includes(s);
  if (t === 'write_file' || t === 'create_file') return { verb: 'Wrote', icon: 'file', tone: 'edit' };
  if (t === 'edit_file' || has('apply_patch') || has('str_replace') || (has('edit') && has('file'))) return { verb: 'Edited', icon: 'diff', tone: 'edit' };
  if (t === 'read_file' || (has('read') && has('file'))) return { verb: 'Read', icon: 'file', tone: 'read' };
  if (t === 'run_command' || has('bash') || has('shell') || has('exec')) return { verb: 'Ran', icon: 'terminal', tone: 'run' };
  if (has('grep') || (has('search') && !has('web') && !has('memory'))) return { verb: 'Searched', icon: 'search', tone: 'search' };
  if (has('glob') || has('list_dir') || has('list_files') || has('ls')) return { verb: 'Listed', icon: 'folder', tone: 'list' };
  if (has('web') || has('fetch_url') || has('http')) return { verb: 'Fetched', icon: 'globe', tone: 'web' };
  if (delegationState === 'not-started') return { verb: 'Delegation not started', icon: 'tasks', tone: 'agent' };
  if (delegationState === 'accepted') return { verb: 'Delegated', icon: 'tasks', tone: 'agent' };
  if (has('agent') || has('spawn') || has('delegate') || has('workflow') || has('task')) return { verb: 'Delegated', icon: 'tasks', tone: 'agent' };
  if (has('memory') || has('recall') || has('persona') || has('briefing')) return { verb: 'Memory', icon: 'plan', tone: 'memory' };
  return { verb: 'Used', icon: 'diff', tone: 'default' };
}

/** The last path segment, for a compact clickable label (full path goes in `title`). */
export function basename(path: string): string {
  const clean = (path || '').replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i >= 0 ? clean.slice(i + 1) : clean;
}
