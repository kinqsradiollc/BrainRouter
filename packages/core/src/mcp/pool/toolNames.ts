/**
 * Tool-name conventions at the pool boundary.
 *
 * The pool normalises tool names to a single convention and needs to know which
 * bare names the BrainRouter MCP owns (for the raw-name back-compat dispatch).
 * Both are pure string helpers, extracted so the pool class stays focused on
 * connection/dispatch state.
 */

/**
 * 0.3.8-R5 — Single-underscore `mcp_<server>_<tool>` is the canonical
 * tool-name shape across the CLI. Any legacy double-underscore
 * `mcp__<server>__<tool>` form that arrives at the pool boundary
 * (e.g. through an external surface or older skill) is collapsed here
 * so downstream code can assume one convention.
 */
export function normalizeMcpToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return name;
  return `mcp_${rest.slice(0, sep)}_${rest.slice(sep + 2)}`;
}

export function isBrainrouterOwnedTool(name: string): boolean {
  return name.startsWith('memory_') ||
    [
      'list_skills',
      'get_skill',
      'search_skills',
      'create_skill',
      'update_skill',
      'get_persona',
      'get_reference',
      'list_template_docs',
      'get_template_doc',
    ].includes(name);
}
