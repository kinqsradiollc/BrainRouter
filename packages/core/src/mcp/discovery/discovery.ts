/**
 * MCP PROGRESSIVE DISCOVERY (0.4.16) — pure catalog search + ranking.
 *
 * When `cli.mcpProgressiveDiscovery` is on, the agent stops advertising every
 * connected MCP tool each turn (token economy on large catalogs) and instead
 * exposes a few discovery entry points (`mcp_search` / `mcp_describe` /
 * `mcp_call`). This module is the search core those tools use: a dependency-free
 * keyword ranker over already-visibility-filtered tools, so it is unit-testable
 * without an Agent or a live MCP pool. The Agent owns the live `listTools()` +
 * visibility filtering and feeds the result here.
 */

/** The fields we read off a namespaced MCP tool descriptor (`mcp_<server>_<tool>`). */
export interface McpCatalogTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Server-local tool name without the `mcp_<server>_` prefix, when the pool set it. */
  __rawName?: string;
  /** Owning server id, when the pool set it. */
  __serverId?: string;
}

/** A compact, model-facing tool entry returned by a search. */
export interface McpToolBrief {
  name: string;
  server?: string;
  summary: string;
}

const MAX_SUMMARY = 200;

/** Collapse whitespace and clip a tool description to a one-line summary. */
export function toToolBrief(tool: McpCatalogTool): McpToolBrief {
  const desc = String(tool.description ?? '').replace(/\s+/g, ' ').trim();
  const summary = desc.length > MAX_SUMMARY ? `${desc.slice(0, MAX_SUMMARY - 1)}…` : desc;
  const brief: McpToolBrief = { name: tool.name, summary };
  if (tool.__serverId) brief.server = tool.__serverId;
  return brief;
}

/** Lowercased name / raw-name / description haystacks for matching. */
function haystacks(tool: McpCatalogTool): { name: string; raw: string; desc: string } {
  return {
    name: String(tool.name ?? '').toLowerCase(),
    raw: String(tool.__rawName ?? '').toLowerCase(),
    desc: String(tool.description ?? '').toLowerCase(),
  };
}

/**
 * Relevance score of a tool for a set of lowercased query terms. A term in the
 * tool/raw name weighs more than one in the description; matching ALL terms
 * earns a small bonus so multi-word queries rank fully-relevant tools first.
 * Returns 0 when no term matches at all (the tool is dropped).
 */
function scoreTool(tool: McpCatalogTool, terms: string[]): number {
  const h = haystacks(tool);
  let score = 0;
  let matchedAll = true;
  for (const term of terms) {
    let termScore = 0;
    if (h.name.includes(term) || h.raw.includes(term)) termScore += 3;
    if (h.desc.includes(term)) termScore += 1;
    if (termScore === 0) matchedAll = false;
    score += termScore;
  }
  if (matchedAll && terms.length > 1) score += 2;
  return score;
}

/**
 * Rank `tools` against a free-text `query` and return the top `maxResults` as
 * compact briefs. An empty query returns the first `maxResults` tools in their
 * given order (a plain "what's available?" listing). Ties keep input order
 * (stable sort), so results are deterministic for a fixed catalog.
 */
export function searchMcpCatalog(
  tools: McpCatalogTool[],
  query: string,
  maxResults: number,
): McpToolBrief[] {
  const limit = Math.max(1, Math.floor(maxResults));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return tools.slice(0, limit).map(toToolBrief);
  const scored = tools
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, terms) }))
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, limit).map((entry) => toToolBrief(entry.tool));
}
