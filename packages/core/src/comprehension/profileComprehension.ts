/**
 * ADR-028 F1/F5/F6 — comprehension is profile-shaped.
 *
 * Different work fails comprehension in different ways, so one mechanism cannot
 * serve all of it:
 *
 *   Engineering  — the ability to change this later without archaeology
 *   Research     — calibration: knowing how much to believe
 *   Study        — the skill itself, which a correct answer removes
 *
 * This maps the workspace profiles that already exist (ADR-021) onto a
 * comprehension mode. It is not a new axis — attaching to an existing profile is
 * the point, because a second taxonomy of "what kind of work is this" would
 * immediately disagree with the first.
 */
import type { WorkspaceProfileId } from '../workspace/profiles.js';
import type { QuestionFocus } from './comprehensionReview.js';

export type ComprehensionMode = 'engineer' | 'researcher' | 'learner';

/**
 * Which mode a profile implies.
 *
 * Most profiles are `engineer` not because everyone writes code, but because
 * the engineer failure — *being unable to change this later* — is the default
 * risk of accepting work you did not produce, whatever the domain.
 */
export function modeForProfile(profile: WorkspaceProfileId | undefined): ComprehensionMode {
  switch (profile) {
    case 'research':
    case 'data-science':
      return 'researcher';
    case 'study':
    case 'education':
      return 'learner';
    default:
      return 'engineer';
  }
}

export interface ModeShape {
  /** What this person must not lose. */
  stake: string;
  /** What the agent owes them. */
  owes: string;
  /** Which question focuses matter most, in order. */
  focusOrder: QuestionFocus[];
}

export const MODE_SHAPE: Record<ComprehensionMode, ModeShape> = {
  engineer: {
    stake: 'the ability to change this later without archaeology',
    owes: 'blast radius, what breaks if the assumption is wrong, and which decision would be expensive to reverse',
    focusOrder: ['consequence', 'reversibility', 'boundary', 'rationale'],
  },
  researcher: {
    stake: 'calibration — knowing how much to believe',
    owes: 'sources with what each actually supports, confidence, and what would falsify the conclusion',
    // Rationale first: for research, WHY a method was chosen determines how
    // much the result is worth, which is the thing being calibrated.
    focusOrder: ['rationale', 'boundary', 'consequence', 'reversibility'],
  },
  learner: {
    stake: 'the skill itself',
    owes: 'the reasoning, at the depth asked for, and the parts they should try before being told',
    focusOrder: ['rationale', 'consequence', 'boundary', 'reversibility'],
  },
};

/* --------------------------------------------------------- F5 · the tutor */

/**
 * Should the agent ask before answering?
 *
 * Only in learner mode, only on instructional questions, and **never for a
 * blocked professional under time pressure.** Socratic method aimed at someone
 * debugging production at 2am is obstruction wearing a teacher's costume.
 *
 * `urgencySignals` is the escape hatch working: the mode is opt-in, and "just
 * tell me" is always one word away and never questioned.
 */
export function shouldAskFirst(input: {
  mode: ComprehensionMode;
  /** True when the question is about understanding rather than unblocking. */
  instructional: boolean;
  /** Words like "urgent", "broken", "production", or an explicit "just tell me". */
  urgencySignals: boolean;
  /** They already answered once — asking again is stalling. */
  alreadyAsked: boolean;
}): boolean {
  if (input.mode !== 'learner') return false;
  if (input.urgencySignals) return false;
  if (input.alreadyAsked) return false;
  return input.instructional;
}

/** Phrases that mean stop teaching and answer. Matched generously on purpose. */
const URGENCY = /\b(just tell me|urgent|asap|production|prod is|outage|broken|on fire|deadline|stuck)\b/i;

export function detectUrgency(text: string): boolean {
  return URGENCY.test(text ?? '');
}

/**
 * The smallest hint that unblocks — not the solution.
 *
 * For a learner, a correct answer delivered instantly is the *worst* outcome:
 * it looks like help and removes the thing they came for.
 */
export function hintLadder(): readonly string[] {
  return [
    'name the area to look at',
    'name the specific thing that is wrong',
    'explain why it is wrong',
    'give the fix',
  ];
}

/* ------------------------------------------------- F6 · research honesty */

export interface ResearchClaim {
  claim: string;
  /** Sources, each with what it ACTUALLY supports — not a bibliography. */
  sources: Array<{ url: string; supports: string }>;
  confidence: 'low' | 'medium' | 'high';
  /**
   * What would overturn this.
   *
   * A conclusion nobody could disprove is not a finding, it is a position —
   * and the difference is invisible in prose written confidently.
   */
  falsifiedBy: string;
}

export function validateResearchClaim(claim: ResearchClaim): string | null {
  if (!claim.falsifiedBy?.trim()) {
    return 'Nothing is stated that would overturn this. A claim nobody could disprove is a position, not a finding.';
  }
  if (claim.sources.length === 0 && claim.confidence !== 'low') {
    return 'No sources, but the confidence is not low. Either cite something or say the confidence is low.';
  }
  for (const source of claim.sources) {
    if (!source.supports?.trim()) {
      // A link appended at the bottom reads as though it supports every
      // sentence above it.
      return `${source.url} is cited without saying what it actually supports.`;
    }
  }
  return null;
}

/**
 * How a research claim is presented.
 *
 * Confidence and the falsifier travel WITH the claim rather than in a footnote,
 * because a reader who stops after the first sentence has still seen both.
 */
export function describeResearchClaim(claim: ResearchClaim): string {
  return [
    claim.claim,
    `Confidence: ${claim.confidence}. This would be wrong if ${claim.falsifiedBy}`,
    ...claim.sources.map((s) => `  ${s.url} — supports: ${s.supports}`),
  ].join('\n');
}

/**
 * Order questions for a mode.
 *
 * The same review, asked in the order that matters for this kind of work.
 */
export function orderForMode<T extends { focus: QuestionFocus }>(
  questions: readonly T[],
  mode: ComprehensionMode,
): T[] {
  const order = MODE_SHAPE[mode].focusOrder;
  return [...questions].sort((a, b) => order.indexOf(a.focus) - order.indexOf(b.focus));
}
