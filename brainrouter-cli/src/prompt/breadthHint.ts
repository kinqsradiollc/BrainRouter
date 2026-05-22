/**
 * Detect "breadth" intent in a user's prompt so the agent loop can inject a
 * fan-out hint asking the LLM to default to `spawn_agents` instead of doing
 * everything sequentially in a single thread.
 *
 * Heuristic only — pure text, no LLM. False positives are cheap (the worst
 * case is the model fans out when it doesn't strictly need to, which is
 * usually still useful). False negatives mean the user gets a single
 * sequential turn for a task that wanted parallelism.
 *
 * Signals we look for:
 *   - Quantifier breadth:    "everything", "all of", "as much as", "every"
 *   - Time-budget breadth:   "in 1 go", "in one shot", "all at once", "at once"
 *   - Coverage breadth:      "thoroughly", "comprehensively", "extensively", "deep dive"
 *   - Verb breadth:          "test more", "explore all", "map everything"
 *   - Multi-tool breadth:    mention of ≥3 tool names or "tools" (plural intent)
 */

export interface BreadthIntent {
  /** Total weighted signal score. The agent prompt threshold is ~2. */
  score: number;
  /** Snippets that triggered (for debugging / explainability). */
  signals: string[];
}

const PHRASE_SIGNALS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(every|everything|all of|each one|as many as|as much as|as much information)\b/i, weight: 1.5, label: 'quantifier-breadth' },
  { pattern: /\bin\s+(1|one)\s+(go|shot|turn|pass)\b/i, weight: 2.0, label: 'one-shot' },
  { pattern: /\b(at\s+once|all at once|in parallel|fan out|fan-out)\b/i, weight: 2.0, label: 'parallel' },
  { pattern: /\b(thoroughly|comprehensively|extensively|exhaustively|deep[- ]?dive|systematically|manually)\b/i, weight: 1.5, label: 'coverage' },
  { pattern: /\b(test\s+(more|all|every|out)|explore\s+(all|every)|map\s+(all|every)|cover\s+all)\b/i, weight: 1.5, label: 'verb-breadth' },
  { pattern: /\b(across|throughout|the whole|the entire)\b/i, weight: 0.7, label: 'spatial-breadth' },
  { pattern: /\bmultiple\s+(angles?|approaches?|directions?|files?|tools?)\b/i, weight: 1.5, label: 'multi-angle' },
  // "as much as I could" or "as much as possible"
  { pattern: /\bas much as\b.*\b(possible|could|I can|you can)\b/i, weight: 1.5, label: 'max-effort' },
  // Realistic broad prompts the original heuristic missed. The user's "test
  // all the MCP tools" / "review every file" / "audit the whole codebase"
  // category — each lands on its own without needing a second signal.
  { pattern: /\b(test|review|audit|check|verify|inspect|analyze|examine|cover)\s+(all|every|each|the\s+(whole|entire|full))\b/i, weight: 2.0, label: 'verb-object-broad' },
  // "every single line", "every single file", "everything in the X"
  { pattern: /\bevery\s+(single|whole)\b/i, weight: 2.0, label: 'emphatic-every' },
  // "make sure things work" + a broad object → effectively a fan-out request
  { pattern: /\bmake\s+sure\s+.*\b(works?|passes?|everything|all)\b/i, weight: 1.0, label: 'verification-blanket' },
  // "for everything" / "for each" — usually appended to a broad noun phrase
  { pattern: /\bfor\s+(everything|each|every|all)\b/i, weight: 1.0, label: 'distributive' },
];

export function detectBreadthIntent(prompt: string): BreadthIntent {
  const text = (prompt ?? '').toString();
  if (!text.trim()) return { score: 0, signals: [] };
  let score = 0;
  const signals: string[] = [];
  for (const { pattern, weight, label } of PHRASE_SIGNALS) {
    if (pattern.test(text)) {
      score += weight;
      signals.push(label);
    }
  }
  return { score, signals };
}

/**
 * Threshold above which we inject a fan-out hint into the system context.
 *
 * Calibration history:
 *  - Original 1.8 missed common prompts that obviously want fan-out
 *    ("test all the MCP tools" scored 1.5, just under). The dedicated
 *    verb-object-broad pattern now scores 2.0 on its own, so the threshold
 *    can stay slightly conservative without missing them.
 *  - A single weaker signal (1.5) plus any 0.7+ companion still clears.
 *  - False positives cost very little (LLM may fan out when it didn't
 *    strictly need to); false negatives mean a sequential single-thread
 *    turn that should have been parallel.
 */
export const BREADTH_FAN_OUT_THRESHOLD = 1.5;

export function shouldSuggestFanOut(prompt: string): { suggest: boolean; intent: BreadthIntent } {
  const intent = detectBreadthIntent(prompt);
  return { suggest: intent.score >= BREADTH_FAN_OUT_THRESHOLD, intent };
}

/**
 * The system message we inject to nudge the agent toward spawn_agents. It
 * intentionally lists concrete child labels so the model has a template to
 * adapt rather than starting from a blank brief.
 */
export function buildFanOutHint(prompt: string, intent: BreadthIntent): string {
  return [
    '## Fan-out hint (auto-detected)',
    '',
    `The user's request looks broad — matched signals: ${intent.signals.join(', ')} (score ${intent.score.toFixed(1)}).`,
    'Instead of doing one tool call and stopping, **default to `spawn_agents` with 3–5 parallel children** covering distinct angles, then synthesize their outputs in a final answer.',
    '',
    '## Recommended fan-out template',
    '- `spawn_agents({ agents: [...] })` — pick 3-5 angles relevant to the request.',
    '- After spawning, `wait_agents({ ids: [...] })` to drain the batch.',
    '- Then synthesize: combine each child\'s preview/output into a single response.',
    '',
    '## Anti-patterns to avoid',
    '- Do NOT call a single tool, write a paragraph, then ask "which should we test next?". The user already said to do everything — execute, do not consult.',
    '- Do NOT serialize what can be parallelized. If two child tasks are independent, spawn them together in one `spawn_agents` call.',
    '- Do NOT skip the synthesis step. The user wants the merged result, not a list of pending child ids.',
  ].join('\n');
}
