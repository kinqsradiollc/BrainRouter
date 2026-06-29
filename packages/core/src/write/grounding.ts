/**
 * WRITE MODE — workspace-doc grounding + per-workspace thread key (§2 W5).
 *
 * The pure core for the Write assistant: a stable, picker-filtered session key so
 * Write threads stay separate from code chats, a formatter that turns recalled /
 * picked document snippets into a prompt grounding block, and a cheap local
 * keyword pre-rank over the workspace's prose files. The brain's vector recall is
 * the PRIMARY grounding source when the brain is online; `pickLocalGrounding` is
 * the desktop's offline fallback — it complements recall, it doesn't replace it.
 */

/** Deterministic, dependency-free 32-bit hash (djb2) for a stable thread key. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * A stable Write-assistant session key for a workspace. The `write:` prefix marks
 * it internal so the chat picker filters it out — Write conversations never mix
 * into the code-chat list.
 */
export function writeThreadKey(workspaceRoot: string): string {
  return `write:${djb2(workspaceRoot || '.')}`;
}

export interface GroundingSnippet {
  /** The document this excerpt came from (a workspace-relative path, ideally). */
  source: string;
  excerpt: string;
}

/**
 * Render grounding snippets into a prompt block the assistant can cite. Capped by
 * `maxChars` (whole snippets only — never a truncated mid-snippet). Empty input →
 * '' (no block), so an offline / no-match turn stays clean.
 */
export function buildGroundingBlock(snippets: GroundingSnippet[], maxChars = 4000): string {
  const usable = snippets.filter((s) => s.excerpt.trim());
  if (!usable.length) return '';
  const head = [
    '## Grounding — relevant workspace documents',
    'Use these as factual context and match their terminology; cite the source path when you rely on one.',
  ];
  const parts: string[] = [];
  let used = 0;
  for (const s of usable) {
    const block = `\n### ${s.source}\n${s.excerpt.trim()}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  if (!parts.length) return '';
  return [...head, ...parts].join('\n');
}

const TERM_RE = /[a-z0-9][a-z0-9'-]{2,}/g;

function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(TERM_RE) ?? []));
}

/** A short excerpt around the first line that mentions any query term (else the head). */
function relevantExcerpt(content: string, queryTerms: Set<string>, maxChars = 600): string {
  const lines = content.split('\n');
  const hit = lines.findIndex((l) => {
    const lc = l.toLowerCase();
    for (const t of queryTerms) if (lc.includes(t)) return true;
    return false;
  });
  const start = hit >= 0 ? Math.max(0, hit - 1) : 0;
  return lines.slice(start, start + 12).join('\n').slice(0, maxChars).trim();
}

export interface WorkspaceDoc { path: string; content: string; }

/**
 * Local (offline) grounding: a cheap keyword-overlap pre-rank over the workspace's
 * prose docs, returning the top `max` as snippets. Excludes `currentPath` (don't
 * ground a doc on itself). Returns [] when the query has no usable terms or
 * nothing overlaps — the caller then grounds purely on the brain recall.
 */
export function pickLocalGrounding(query: string, docs: WorkspaceDoc[], currentPath?: string, max = 3): GroundingSnippet[] {
  const q = terms(query);
  if (!q.size) return [];
  const scored = docs
    .filter((d) => d.path !== currentPath && d.content.trim())
    .map((d) => {
      const lc = d.content.toLowerCase();
      let score = 0;
      for (const t of q) if (lc.includes(t)) score++;
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.d.path.localeCompare(b.d.path))
    .slice(0, max);
  return scored.map(({ d }) => ({ source: d.path, excerpt: relevantExcerpt(d.content, q) }));
}
