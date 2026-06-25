/**
 * CC-P5.2 — `/usage` per-actor breakdown (0.4.15 thread L/E polish).
 *
 * `/tokens` shows session totals; `/usage` answers "where did they GO": the
 * parent vs every child agent (role, in/out tokens, calls, wall-clock),
 * cache hit-rate, and the context the offload machinery kept out of the
 * window. Pure formatter — the command layer feeds live numbers.
 */

export interface ActorUsage {
  id: string;
  role?: string;
  label?: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  wallClockMs?: number;
}

export interface UsageBreakdownInput {
  parent: {
    promptTokens: number;
    completionTokens: number;
    calls: number;
    turns: number;
    cachedTokens: number;
    missedTokens: number;
  };
  children: ActorUsage[];
  offload?: { childTokensSpent: number; offloadCharsAvoided: number };
  /** WS0 — session prefix-cache stability (cache-stable-prefix hits vs busts). */
  prefixStability?: { stableCalls: number; bustCalls: number; ratio: number; lastLabels: string[] };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Build the `/usage` lines. Pure. */
export function buildUsageBreakdown(input: UsageBreakdownInput): string[] {
  const p = input.parent;
  const lines: string[] = [];

  const cacheable = p.cachedTokens + p.missedTokens;
  lines.push('Token usage by actor:');
  lines.push('');
  lines.push(
    `  parent      ${fmt(p.promptTokens)} in / ${fmt(p.completionTokens)} out · ${p.calls} calls · ${p.turns} turns` +
    (cacheable > 0 ? ` · cache hit ${pct(p.cachedTokens, cacheable)}` : ''),
  );

  const children = [...input.children].sort(
    (a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens),
  );
  const shown = children.slice(0, 10);
  for (const c of shown) {
    const who = `${c.role ?? 'agent'}${c.label ? ` "${c.label}"` : ''} ${c.id}`.trim();
    const wall = c.wallClockMs !== undefined ? ` · ${(c.wallClockMs / 1000).toFixed(1)}s` : '';
    lines.push(`  ${who} — ${fmt(c.promptTokens)} in / ${fmt(c.completionTokens)} out · ${c.calls} calls${wall}`);
  }
  if (children.length > shown.length) {
    const rest = children.slice(shown.length);
    const rp = rest.reduce((n, c) => n + c.promptTokens, 0);
    const rc = rest.reduce((n, c) => n + c.completionTokens, 0);
    lines.push(`  …and ${rest.length} more children — ${fmt(rp)} in / ${fmt(rc)} out`);
  }

  const childPrompt = children.reduce((n, c) => n + c.promptTokens, 0);
  const childCompletion = children.reduce((n, c) => n + c.completionTokens, 0);
  const totalIn = p.promptTokens + childPrompt;
  const totalOut = p.completionTokens + childCompletion;
  lines.push('');
  lines.push(`  TOTAL       ${fmt(totalIn)} in / ${fmt(totalOut)} out (children: ${pct(childPrompt + childCompletion, totalIn + totalOut)})`);

  if (input.offload && (input.offload.childTokensSpent > 0 || input.offload.offloadCharsAvoided > 0)) {
    lines.push(`  offload     ${fmt(input.offload.offloadCharsAvoided)} chars of child output kept out of the parent window`);
  }
  // WS0 0.5 — cache savings: cached vs full-price input tokens. The cached count
  // is what the provider's prefix cache SERVED (didn't re-bill at the full input
  // rate) — the payoff of prefix stability, in provider-agnostic token terms. ($
  // saved is deliberately omitted: it needs per-provider pricing, which an
  // OpenAI-compatible endpoint doesn't expose and we don't hardcode.)
  if (cacheable > 0) {
    lines.push(`  cache       ${fmt(p.cachedTokens)} tokens served from cache · ${fmt(p.missedTokens)} full-price (${pct(p.cachedTokens, cacheable)} hit)`);
  }
  // WS0 — prefix-cache stability: the share of calls whose cache-stable prefix
  // was byte-identical to the prior call (so the provider prefix-cache served
  // it). The measurable signal a prefix-ordering change is judged against.
  const ps = input.prefixStability;
  if (ps && ps.stableCalls + ps.bustCalls > 0) {
    const last = ps.bustCalls > 0 && ps.lastLabels.length ? ` · last bust: ${ps.lastLabels[0]}` : '';
    lines.push(`  prefix      ${(ps.ratio * 100).toFixed(1)}% cache-stable across ${ps.stableCalls + ps.bustCalls} calls (${ps.bustCalls} ${ps.bustCalls === 1 ? 'bust' : 'busts'})${last}`);
  }
  return lines;
}
