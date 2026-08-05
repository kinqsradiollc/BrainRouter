/**
 * ADR-028 F7 — the comprehension review.
 *
 * A code review pointed at your understanding instead of the code. Same
 * lifecycle: requested → produced → answered → findings.
 *
 * This reverses an earlier refusal in this ADR, which listed "quizzing the
 * person on their own codebase" as something to never build. That was wrong.
 * The thing worth refusing is an UNPROMPTED quiz; an invoked one is a different
 * artifact that happens to share a shape. Nobody calls a code review
 * patronising, because you asked for it and it tells you something.
 *
 * The rule that keeps it honest, and the reason it is not a grading tool:
 *
 *   **A wrong answer is not always the human's.**
 *
 * The agent wrote the code from its own model of what was wanted, and that
 * model can be wrong in ways the tests do not catch. So a disagreement produces
 * a FINDING, not a mark — and if the human's reasoning holds, the output is a
 * defect report about the code rather than a score about the person.
 */

export type QuestionForm = 'multiple_choice' | 'free_text' | 'predict_failure';

/**
 * What a question is about.
 *
 * Consequences and decisions, never trivia. "Which file is this in" tests
 * nothing you cannot grep. The questions that matter are the ones whose answers
 * you would need before changing this code.
 */
export type QuestionFocus =
  /** What breaks if the assumption is wrong. */
  | 'consequence'
  /** Why the rejected alternative was rejected. */
  | 'rationale'
  /** Which part would be expensive to reverse. */
  | 'reversibility'
  /** What this deliberately does NOT handle. */
  | 'boundary';

export interface ComprehensionQuestion {
  id: string;
  form: QuestionForm;
  focus: QuestionFocus;
  prompt: string;
  /** For multiple choice. Distractors are plausible MISTAKES, never filler. */
  options?: string[];
  /** The index of the correct option, or the expected substance for free text. */
  expected: string;
  /** Why that is the answer — shown after answering, right or wrong. */
  explanation: string;
  /** Where in the change this came from, so the answer can be checked. */
  reference?: string;
}

export interface ComprehensionReview {
  id: string;
  /** What the review is about, in one line. */
  subject: string;
  questions: ComprehensionQuestion[];
  createdAt: string;
}

export type AnswerVerdict =
  | 'matches'
  /** The human's answer differs — which is a FINDING, not a mark. */
  | 'differs'
  /** Skipped. Legitimate, and more useful than a guess. */
  | 'skipped'
  /**
   * Free text that only a model can fairly judge.
   *
   * The honest verdict, and the reason this exists: a string heuristic marked
   * "it keeps both and flags them as conflicted" as WRONG against "both
   * versions are kept and marked conflicted". Someone who understands the code
   * perfectly and described it in their own words would have been told they
   * were wrong — by a feature whose entire purpose is helping them understand.
   *
   * Rather than tune the threshold until the test passed, the deterministic
   * path admits what it cannot decide. Same rule as B1: do not claim a state
   * you have not established.
   */
  | 'needs_model_judgement';

export interface AnsweredQuestion {
  questionId: string;
  answer: string | null;
  verdict: AnswerVerdict;
}

/**
 * A disagreement, stated as two positions rather than one score.
 *
 * `mine` is the agent's reasoning, `yours` is the human's. Presenting them side
 * by side is the whole design: a comprehension review that can only ever find
 * the human wanting is a grading tool, and grading tools get closed.
 */
export interface ComprehensionFinding {
  questionId: string;
  prompt: string;
  mine: string;
  yours: string;
  /**
   * What to do about it. Deliberately NOT "you were wrong" — the honest
   * options are that the human missed something, the code is unclear, or the
   * agent misunderstood the requirement.
   */
  resolution: 'gap_in_understanding' | 'code_is_unclear' | 'agent_may_be_wrong';
}

/* ---------------------------------------------------------------- authoring */

/** Below this a review is not worth invoking; above it, it is homework. */
export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 7;

/**
 * Is this a question worth asking?
 *
 * The check that keeps the feature from degenerating into trivia. A question
 * whose answer is visible in the diff is a bad question — the value is entirely
 * in what the diff cannot show.
 */
export function validateQuestion(q: ComprehensionQuestion): string | null {
  const prompt = q.prompt?.trim() ?? '';
  if (prompt.length < 15) return 'A question needs to be a real question.';
  if (!q.explanation?.trim()) {
    // Without this, a wrong answer teaches nothing and the review becomes a
    // score.
    return 'Every question needs an explanation, shown whether the answer was right or wrong.';
  }
  if (/\bwhich file\b|\bwhat line\b|\bhow many lines\b/i.test(prompt)) {
    return 'That is trivia — you can grep for it. Ask about a consequence, a rationale, or a boundary.';
  }
  if (q.form === 'multiple_choice') {
    if (!q.options || q.options.length < 3) {
      return 'Multiple choice needs at least three options; two is a coin flip.';
    }
    if (new Set(q.options).size !== q.options.length) {
      return 'Two options are identical, so one of them cannot be wrong.';
    }
  }
  return null;
}

export function validateReview(review: ComprehensionReview): string | null {
  if (review.questions.length < MIN_QUESTIONS) {
    return `A review needs at least ${MIN_QUESTIONS} questions to be worth invoking.`;
  }
  if (review.questions.length > MAX_QUESTIONS) {
    return `${review.questions.length} questions is homework, not a review. Cap is ${MAX_QUESTIONS}.`;
  }
  for (const q of review.questions) {
    const bad = validateQuestion(q);
    if (bad) return `${q.id}: ${bad}`;
  }
  // Every focus being the same produces a review that tests one thing four
  // ways, which is less useful than four questions testing four things.
  const focuses = new Set(review.questions.map((q) => q.focus));
  if (focuses.size === 1 && review.questions.length > 3) {
    return 'Every question has the same focus — vary consequence, rationale, reversibility and boundary.';
  }
  return null;
}

/* ---------------------------------------------------------------- answering */

/**
 * Judge an answer, deterministically where that is possible and honestly where
 * it is not.
 *
 * Multiple choice and skips are decidable here. **Free text is not**, and
 * pretending otherwise is the one failure this feature cannot afford: a person
 * who understands the code and phrased it their own way, told they are wrong by
 * the thing meant to help them understand, will not open it again.
 *
 * So free text returns `needs_model_judgement` and the model decides, with the
 * human's exact words in front of it. Slower and correct beats instant and
 * insulting.
 */
export function judgeAnswer(
  question: ComprehensionQuestion,
  answer: string | null,
): AnswerVerdict {
  if (answer === null || answer.trim() === '') return 'skipped';
  if (question.form === 'multiple_choice') {
    return answer.trim().toLowerCase() === question.expected.trim().toLowerCase()
      ? 'matches'
      : 'differs';
  }
  return 'needs_model_judgement';
}

/**
 * The prompt handed to the model for a free-text answer.
 *
 * Explicitly invites the model to find ITSELF wrong. Without that instruction
 * the natural behaviour is to defend the expected answer, which turns every
 * disagreement into the human's fault and loses the case where the human has
 * spotted a genuine defect.
 */
export function buildJudgePrompt(question: ComprehensionQuestion, answer: string): string {
  return [
    'Judge whether this answer shows the same understanding as the expected one.',
    'Different wording is FINE — you are judging the model, not the phrasing.',
    '',
    `Question: ${question.prompt}`,
    `Expected: ${question.expected}`,
    `Their answer: ${answer}`,
    '',
    'Answer "matches" or "differs".',
    'If their answer is different but CORRECT — if they have spotted something the expected',
    'answer got wrong — say "differs" and explain that the expected answer is the one at fault.',
  ].join('\n');
}

/**
 * Turn a disagreement into a finding.
 *
 * `agent_may_be_wrong` is a real option, not a courtesy. The agent built this
 * from its own reading of the requirement, and a confident human answer that
 * contradicts it is evidence worth taking seriously — that is how a
 * comprehension review finds a bug rather than a gap.
 */
export function toFinding(
  question: ComprehensionQuestion,
  answer: string,
): ComprehensionFinding {
  return {
    questionId: question.id,
    prompt: question.prompt,
    mine: question.explanation,
    yours: answer,
    // Rationale disagreements are the ones most likely to mean the AGENT
    // misread the intent: it chose the approach, so its explanation is a claim
    // about someone else's requirement.
    resolution: question.focus === 'rationale' ? 'agent_may_be_wrong' : 'gap_in_understanding',
  };
}

/* ----------------------------------------------------------------- outcomes */

export interface ReviewOutcome {
  answered: number;
  skipped: number;
  findings: ComprehensionFinding[];
  /** The parts of the change with no established model — the actionable bit. */
  gaps: QuestionFocus[];
}

/**
 * What the review produced.
 *
 * Deliberately NOT a score. The output is *which parts of this change you do
 * not yet have a model of*, which is actionable, rather than *how you did*,
 * which is a judgement nobody asked for. Nothing here is stored across
 * reviews — a history of wrong answers turns one honest tool into a
 * performance file.
 */
export function summarizeReview(
  review: ComprehensionReview,
  answers: readonly AnsweredQuestion[],
): ReviewOutcome {
  const byId = new Map(review.questions.map((q) => [q.id, q]));
  const findings: ComprehensionFinding[] = [];
  const gaps = new Set<QuestionFocus>();
  let answered = 0;
  let skipped = 0;

  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q) continue;
    if (a.verdict === 'skipped') {
      skipped += 1;
      // A skip identifies the gap precisely — more useful than a guess.
      gaps.add(q.focus);
      continue;
    }
    answered += 1;
    if (a.verdict === 'needs_model_judgement') {
      // Not yet decided, so it is neither a finding nor a gap. Counting it as
      // either would report a conclusion nothing established.
      continue;
    }
    if (a.verdict === 'differs' && a.answer) {
      findings.push(toFinding(q, a.answer));
      gaps.add(q.focus);
    }
  }
  return { answered, skipped, findings, gaps: [...gaps] };
}

const FOCUS_GAP: Record<QuestionFocus, string> = {
  consequence: 'what breaks when the assumptions do not hold',
  rationale: 'why this approach was chosen over the alternatives',
  reversibility: 'which parts would be expensive to undo',
  boundary: 'what this deliberately does not handle',
};

/**
 * The closing line.
 *
 * Names what to go and look at, never how many were right. "4/6" invites you to
 * feel a way about yourself; "the rationale is the part without a model yet"
 * invites you to go read something.
 */
export function describeOutcome(outcome: ReviewOutcome): string {
  if (outcome.gaps.length === 0) {
    return 'Your model of this change matches the one it was built from.';
  }
  const parts = outcome.gaps.map((g) => FOCUS_GAP[g]);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  const disputed = outcome.findings.filter((f) => f.resolution === 'agent_may_be_wrong').length;
  const tail = disputed > 0
    ? ` ${disputed} of these may be MY misreading rather than yours — worth checking.`
    : '';
  return `Worth a second look: ${list}.${tail}`;
}
