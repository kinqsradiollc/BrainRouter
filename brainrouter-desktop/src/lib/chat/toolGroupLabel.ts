/**
 * Item 12 (chat clarity) — the collapsed label for a tool-group row. A live step
 * reads "Using <tool> ✶"; a finished single tool reads "<tool> — <summary>"; a
 * finished multi-tool step lists the DISTINCT tool names ("3 tools · read · edit
 * · grep") so you can see what it did without expanding. Pure + unit-tested.
 */
export interface ToolItemLike {
  tool: string;
  summary?: string;
  child?: string;
}

export function toolGroupLabel(items: ToolItemLike[], live: boolean, maxNames = 4): string {
  if (items.length === 0) return live ? 'Working ✶' : 'No tools';
  const last = items[items.length - 1];
  if (live) return `Using ${last.child ? `[${last.child}] ` : ''}${last.tool} ✶`;
  if (items.length === 1) {
    const only = items[0];
    return `${only.child ? `[${only.child}] ` : ''}${only.tool}${only.summary ? ` — ${only.summary}` : ''}`;
  }
  const names = [...new Set(items.map((i) => i.tool))];
  const namesLabel = names.slice(0, maxNames).join(' · ') + (names.length > maxNames ? ` +${names.length - maxNames}` : '');
  return `${items.length} tools · ${namesLabel}`;
}
