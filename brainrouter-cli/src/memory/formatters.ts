/**
 * Compact renderers for BrainRouter memory tool results.
 *
 * The raw `memory_recall` / `memory_search` payload can be 70k+ chars of
 * mixed JSON + Mermaid graph context + persona blocks. Dumping it to stdout
 * gave the user a "JSON sea" and gave the LLM 70k tokens of noise to
 * hallucinate from. These helpers parse the result and render a small,
 * card-style list keyed by recordId so the human reader (and any downstream
 * LLM citation) only sees the facts that are actually present.
 */

import chalk from 'chalk';

export interface FlatMemory {
  recordId: string;
  type: string;
  content: string;
  sceneName?: string;
  skillTag?: string;
  priority?: number;
  confidence?: number;
  /** Times this record has been retrieved AND cited by the model in a turn. */
  citationCount?: number;
  /** Times this record was retrieved but the model did NOT cite it. */
  neverCitedCount?: number;
}

/**
 * Compute citation precision — `citationCount / (citationCount + neverCitedCount)`.
 * Returns `null` when the record has no recall history yet (denominator 0), so
 * callers can render "—" instead of misleading "0%". Records under 0.20
 * precision are visually flagged as noisy.
 */
export function recallPrecision(m: FlatMemory): number | null {
  const cited = m.citationCount ?? 0;
  const never = m.neverCitedCount ?? 0;
  const total = cited + never;
  if (total === 0) return null;
  return cited / total;
}

/**
 * Extract the flat memory list from whatever shape memory_recall /
 * memory_search returned. The MCP wraps payloads in `<relevant-memories>`
 * XML inside `prependContext`, and ALSO returns parsed arrays at the top
 * level depending on the variant. We tolerate both.
 */
export function extractMemories(parsed: any): FlatMemory[] {
  const out: FlatMemory[] = [];
  const push = (m: any) => {
    if (!m || typeof m !== 'object') return;
    const recordId = (m.recordId ?? m.record_id ?? m.id ?? '').toString();
    if (!recordId) return;
    const citationCount = m.citationCount ?? m.citation_count;
    const neverCitedCount = m.neverCitedCount ?? m.never_cited_count;
    out.push({
      recordId,
      type: (m.type ?? 'memory').toString(),
      content: (m.content ?? m.text ?? '').toString().replace(/\s+/g, ' ').trim(),
      sceneName: m.sceneName ?? m.scene_name,
      skillTag: m.skillTag ?? m.skill_tag,
      priority: typeof m.priority === 'number' ? m.priority : undefined,
      confidence: typeof m.confidence === 'number' ? m.confidence : undefined,
      citationCount: typeof citationCount === 'number' ? citationCount : undefined,
      neverCitedCount: typeof neverCitedCount === 'number' ? neverCitedCount : undefined,
    });
  };

  // Direct arrays first. The canonical MCP key is `recalledCognitiveMemories`;
  // the others are tolerated for older payloads / shimmed responses.
  for (const key of [
    'recalledCognitiveMemories',
    'recalledCognitiveRecords',
    'records',
    'memories',
    'recalledMemories',
  ]) {
    if (Array.isArray(parsed?.[key])) parsed[key].forEach(push);
  }

  // Parse the XML-style prependContext if present and we still have nothing.
  if (out.length === 0 && typeof parsed?.prependContext === 'string') {
    const text: string = parsed.prependContext;
    // Match `  - [type|scene] content (skill: xxx)` lines. The MCP doesn't
    // include the recordId in this text-only block, so we synthesize one for
    // display purposes only — recall callers that need real ids should hit
    // the JSON path above.
    const re = /-\s+\[([^\]|]+)\|([^\]]+)\]\s+([^\n]+)/g;
    let match: RegExpExecArray | null;
    let i = 0;
    while ((match = re.exec(text)) !== null) {
      out.push({
        recordId: `inline-${i++}`,
        type: match[1].trim(),
        content: match[3].replace(/\(skill:.*$/, '').trim(),
        sceneName: match[2].trim(),
      });
    }
  }

  return out;
}

/**
 * Render a compact ANSI-colored block: heading + N cards, each with the
 * recordId, type tag, scene tag, and a one-line content preview. Returns
 * the formatted string (no console.log here so callers can choose target).
 */
export function renderMemoryCards(memories: FlatMemory[], heading: string, limit = 10): string {
  if (memories.length === 0) {
    return `${chalk.bold(heading)}\n  ${chalk.yellow('(no records returned)')}\n`;
  }
  const lines: string[] = [chalk.bold(heading)];
  for (const m of memories.slice(0, limit)) {
    const id = chalk.gray(m.recordId.length > 40 ? m.recordId.slice(0, 37) + '…' : m.recordId);
    const type = chalk.cyan(`[${m.type}]`);
    const scene = m.sceneName ? chalk.gray(` · ${m.sceneName}`) : '';
    const preview = m.content.length > 200 ? m.content.slice(0, 197) + '…' : m.content;
    lines.push(`  ${type}${scene}${renderCitationBadge(m)}`);
    lines.push(`    ${id}`);
    lines.push(`    ${preview}`);
  }
  if (memories.length > limit) {
    lines.push(chalk.gray(`  …and ${memories.length - limit} more (use /memory <query> to filter further)`));
  }
  return lines.join('\n') + '\n';
}

/**
 * Render a per-card citation badge — `· cited 3 · uncited 12 (20%) ⚠️ noisy`.
 * Hidden when the record has no recall history at all (denominator 0), so a
 * just-extracted memory doesn't pick up a misleading "0%" tag on its first
 * surface. Visible threshold for the noisy flag matches T5: precision < 20%.
 */
function renderCitationBadge(m: FlatMemory): string {
  const cited = m.citationCount ?? 0;
  const never = m.neverCitedCount ?? 0;
  if (cited === 0 && never === 0) return '';
  const precision = recallPrecision(m);
  const pctText = precision === null ? '—' : `${Math.round(precision * 100)}%`;
  const noisy = precision !== null && precision < 0.2 ? ' ⚠️ noisy' : '';
  return chalk.gray(` · cited ${cited} · uncited ${never} (${pctText})`) + (noisy ? chalk.yellow(noisy) : '');
}

/**
 * Bound a raw payload to a maximum size so the agent's context doesn't get
 * blown out by a 70k-char working_context dump. Used by the briefing / slash
 * command rendering paths.
 */
export function clampPayload(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[${text.length - maxChars} chars truncated]`;
}
