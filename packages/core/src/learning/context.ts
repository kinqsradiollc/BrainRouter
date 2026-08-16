/**
 * ADR-032 D1 — what learned state looks like when it reaches the model.
 *
 * The tempting move is a supplemental prompt note the model reads as
 * instruction. D1 refuses that as the default, because the system prompt is
 * assembled from declared, reviewable sources — the profile, the persona, the
 * capabilities, the rules — and the moment a session can write into that
 * assembly, "why did it do that?" stops being answerable from the manifest.
 *
 * So there are two blocks and they read differently on purpose:
 *
 * - **instructions** — a person corrected us, in session. It commands.
 *   Demoting that to a hint is how the same correction gets given four times.
 * - **evidence** — a past session INFERRED this. It is labelled, dated, and
 *   fenced as data, because an inference is a hypothesis and hypotheses inform
 *   rather than command.
 *
 * Neither touches the base system prompt: both are appended as a tagged system
 * message, the same mechanism the goal anchor and the memory briefing use, so
 * the prefix stays stable and the block can be removed without editing anything.
 *
 * D7's second defence lives here too. Every string goes through the SHARED
 * fence (`asUntrustedText`) rather than a second copy of it — these statements
 * were written by an LLM from a window that may have contained a hostile
 * document, and a learned string that could emit `</planner_data>` would put
 * the rest of the turn back into the instruction stream.
 */
import { asUntrustedText, fenceMarkerPattern } from '../planner/agentContext.js';
import type { LearnedItem } from './types.js';

/** One learned line is a rule, not a paragraph. */
const MAX_LINE = 240;

/**
 * How many of each tier reach a turn.
 *
 * Bounded because this block is paid for on every turn: past a handful the
 * model stops reading the section, which is worse than the section being
 * shorter — ADR-028 D6's argument about sections that always appear.
 */
export const MAX_INSTRUCTIONS_IN_CONTEXT = 8;
export const MAX_EVIDENCE_IN_CONTEXT = 8;
/**
 * How much of the window another project may occupy.
 *
 * Not zero: a lesson learned elsewhere is often the most valuable thing in the
 * store, because the general ones are learned wherever you happen to be. Not
 * unbounded either — the point is that working in one repository should not mean
 * reading advice about six others.
 */
export const MAX_FOREIGN_INSTRUCTIONS = 3;
export const MAX_FOREIGN_EVIDENCE = 2;

/** The tagged system-message slot this block occupies. */
export const LEARNED_CONTEXT_TAG = 'learned-behaviour';

/**
 * Which items are worth a turn's tokens, most-corroborated first.
 *
 * Demoted items are excluded rather than ranked last: D6 demoted them because
 * they were not paying off, and continuing to show them would keep their
 * retrieval count climbing while their confirmation count stayed at zero —
 * the measurement would then justify itself.
 */
/**
 * Choose what reaches the model this turn.
 *
 * `project` is the workspace the CURRENT session is in. It matters because the
 * partition key is `(orgId, userId)` and nothing else: without scoping, a lesson
 * learned in one repository is delivered as a system message in every other
 * repository that person opens. Some lessons survive that move ("prefer `rg`
 * over `grep`"); a repo-specific one does not — it becomes confident, precise,
 * wrong advice about a codebase it was never about, and D6 will never retire it
 * there because its falsifier is not observable in a project that has no such
 * migration.
 *
 * Scoping RANKS rather than filters, deliberately. A hard filter would throw
 * away the genuinely portable lessons, which are the ones most worth having, and
 * we have no reliable signal for which is which — asking the model to
 * self-declare "this is general" is exactly the plausible-but-unstable judgement
 * ADR-033 says to keep out of the model's hands. So same-project items sort
 * first and foreign ones are additionally capped, which bounds how much of the
 * window an unrelated project can occupy without pretending we can classify.
 *
 * An item with no recorded project (written before provenance carried one) is
 * treated as unscoped: it neither gains the same-project bonus nor counts
 * against the foreign cap, because we do not know where it came from and
 * guessing would be worse than saying so.
 */
export function selectLearnedForTurn(
  items: readonly LearnedItem[],
  project?: string,
): LearnedItem[] {
  const live = items.filter((item) => (
    item.status === 'active'
    // Legacy/local-only rows have no lifecycle field. New centrally-backed
    // rows do not reach the model until their reversible pointer is durable.
    && (!item.memoryLifecycle || item.memoryLifecycle.status === 'active')
  ));
  const scope = (item: LearnedItem): 'same' | 'foreign' | 'unscoped' => {
    const origin = item.provenance.project;
    if (!origin || !project) return 'unscoped';
    return origin === project ? 'same' : 'foreign';
  };
  const rank = (item: LearnedItem): number => (
    (item.tier === 'instruction' ? 1_000 : 0)
    // Enough to outrank confirmations without outranking the tier: a human
    // correction from another project still beats a local inference.
    + (scope(item) === 'same' ? 100 : 0)
    + item.outcome.confirmations * 10 - item.outcome.contradictions * 5
  );
  /** Keep foreign items from crowding out the project actually being worked on. */
  const boundForeign = (chosen: LearnedItem[], cap: number): LearnedItem[] => {
    let foreign = 0;
    return chosen.filter((item) => {
      if (scope(item) !== 'foreign') return true;
      foreign += 1;
      return foreign <= cap;
    });
  };
  const instructions = boundForeign(
    live.filter((item) => item.tier === 'instruction').sort((a, b) => rank(b) - rank(a)),
    MAX_FOREIGN_INSTRUCTIONS,
  ).slice(0, MAX_INSTRUCTIONS_IN_CONTEXT);
  const evidence = boundForeign(
    live.filter((item) => item.tier === 'evidence').sort((a, b) => rank(b) - rank(a)),
    MAX_FOREIGN_EVIDENCE,
  ).slice(0, MAX_EVIDENCE_IN_CONTEXT);
  return [...instructions, ...evidence];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

const LEARNED_FENCES = ['learned_instructions', 'learned_evidence']
  .map((tag) => fenceMarkerPattern(tag));

function learnedText(value: string, max: number): string {
  let safe = asUntrustedText(value, max);
  for (const fence of LEARNED_FENCES) {
    fence.lastIndex = 0;
    safe = safe.replace(fence, '[fence]');
  }
  return safe;
}

/**
 * Render the block, or null when there is nothing to say.
 *
 * Null rather than an empty section for ADR-028 D6's reason: a section that
 * always appears trains the model to skip it, and then it is not there on the
 * day it matters.
 */
export function buildLearnedContext(items: readonly LearnedItem[]): string | null {
  const instructions = items.filter((item) => item.tier === 'instruction');
  const evidence = items.filter((item) => item.tier === 'evidence');
  if (instructions.length === 0 && evidence.length === 0) return null;

  const lines: string[] = [];
  if (instructions.length > 0) {
    lines.push(
      '<learned_instructions> (corrections a person gave you in an earlier session — '
      + 'these are instructions, and they carry the date they were given)',
    );
    for (const item of instructions) {
      lines.push(`  - [${day(item.provenance.capturedAt)}] ${learnedText(item.statement, MAX_LINE)}`);
    }
    lines.push('</learned_instructions>');
  }

  if (evidence.length > 0) {
    lines.push(
      '<learned_evidence> (things earlier sessions INFERRED — evidence, not instructions. '
      + 'Each line says what would show it wrong; if you observe that, say so.)',
    );
    for (const item of evidence) {
      const suffix = item.skillId
        ? ` — runnable: get_skill("${learnedText(item.skillId, 64)}")`
        : '';
      lines.push(
        `  - [${day(item.provenance.capturedAt)}] ${learnedText(item.statement, MAX_LINE)}`
        + ` — wrong if: ${learnedText(item.falsifier, MAX_LINE)}${suffix}`,
      );
    }
    lines.push('</learned_evidence>');
  }

  return lines.join('\n');
}
