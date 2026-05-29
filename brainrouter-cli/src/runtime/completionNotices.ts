/**
 * PARITY-W3 (0.4.2) — idle background-completion notifications.
 *
 * Pure helpers for surfacing "a background actor (child agent / worker /
 * workflow run) just finished while you were idle" as a print-above-prompt
 * notice. The REPL collects current terminal actors each tick and diffs them
 * against a `seen` set; anything new is announced (once) when the composer is
 * idle. Kept pure so the diff + formatting are unit-tested without the REPL.
 */

export interface CompletionItem {
  /** Stable id across ticks, namespaced by kind, e.g. `wkr:abc`, `agent:c1`, `run:slug`. */
  id: string;
  /** One-line human label, e.g. `worker wkr_abc (reviewer) completed`. */
  label: string;
  /** Did it finish successfully? Drives the ✓/✗ glyph + info/warn level. */
  ok: boolean;
}

/**
 * Items that are terminal now but weren't acknowledged before — the new
 * completions to announce. Pure set-difference by `id`.
 */
export function newlyTerminal(seen: Set<string>, current: CompletionItem[]): CompletionItem[] {
  return current.filter((c) => !seen.has(c.id));
}

/** Format the print-above-prompt notice line for a finished background actor. */
export function formatCompletionNotice(item: CompletionItem): string {
  return `${item.ok ? '✓' : '✗'} ${item.label}`;
}
