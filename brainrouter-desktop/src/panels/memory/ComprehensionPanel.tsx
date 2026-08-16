/**
 * ADR-028 F7 — the comprehension review panel.
 *
 * A code review pointed at your understanding. The agent asks, you answer, it
 * validates — and a disagreement produces a finding rather than a mark.
 *
 * In a panel rather than in chat because you want this when deciding whether to
 * accept work, which is minutes to days after the message that produced it. A
 * panel persists; a message is gone by the next turn.
 *
 * Two things this panel refuses to render, and they are the design:
 *
 *  - **No score.** Not "4/6", not a percentage, not a streak. The output is
 *    which parts you do not have a model of, which is actionable.
 *  - **No grading language.** "Correct"/"incorrect" makes it a test. The words
 *    are "matches" and "differs", because sometimes the one that differs is
 *    the agent's.
 */
import React, { useState } from 'react';
import { Button } from '../../components/primitives/Button.js';
import { Icon } from '../../icons.js';

export interface QuestionView {
  id: string;
  form: 'multiple_choice' | 'free_text' | 'predict_failure';
  focus: 'consequence' | 'rationale' | 'reversibility' | 'boundary';
  prompt: string;
  options?: string[];
  explanation: string;
  reference?: string;
}

export interface AnswerState {
  answer: string | null;
  verdict: 'matches' | 'differs' | 'skipped' | 'needs_model_judgement' | null;
  /** The agent's position, once it has judged. */
  mine?: string;
}

const FOCUS_LABEL: Record<QuestionView['focus'], string> = {
  consequence: 'what breaks',
  rationale: 'why this way',
  reversibility: 'hard to undo',
  boundary: 'not handled',
};

export function ComprehensionPanel({
  subject, questions, answers, outcome, busy, onAnswer, onSkip, onStart, onDispute,
}: {
  /** Absent until a review has been requested — this panel is never unsolicited. */
  subject: string | null;
  questions: QuestionView[];
  answers: Record<string, AnswerState>;
  /** The closing line: gaps, never a score. */
  outcome: string | null;
  busy?: boolean;
  onAnswer: (questionId: string, answer: string) => void;
  onSkip: (questionId: string) => void;
  onStart: () => void;
  /** "I think you're wrong" — the path that turns a mark into a defect report. */
  onDispute: (questionId: string) => void;
}): React.ReactElement {
  if (!subject) {
    return (
      <div className="scroll comp-panel">
        <div className="empty">
          <span className="empty-title">Check your understanding</span>
          <span className="empty-note">
            Ask for a review of work the agent just produced. It asks about consequences and
            decisions — the parts a diff cannot show — and you can disagree with its answers.
          </span>
          <Button variant="primary" onClick={onStart} disabled={busy}>
            <Icon name="brain" size={12} /> Review my understanding
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="scroll comp-panel">
      <div className="comp-head">
        <span className="comp-subject">{subject}</span>
        <Button variant="default" onClick={onStart} disabled={busy}>New review</Button>
      </div>

      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          index={i + 1}
          question={q}
          state={answers[q.id] ?? { answer: null, verdict: null }}
          onAnswer={onAnswer}
          onSkip={onSkip}
          onDispute={onDispute}
        />
      ))}

      {outcome ? (
        // Names what to go and look at, never how many were right. "4/6"
        // invites you to feel a way about yourself.
        <div className="comp-outcome">{outcome}</div>
      ) : null}
    </div>
  );
}

function QuestionCard({
  index, question, state, onAnswer, onSkip, onDispute,
}: {
  index: number;
  question: QuestionView;
  state: AnswerState;
  onAnswer: (id: string, answer: string) => void;
  onSkip: (id: string) => void;
  onDispute: (id: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState('');
  const answered = state.verdict !== null;

  return (
    <div className={`comp-card${answered ? ' answered' : ''}`}>
      <div className="comp-q-head">
        <span className="comp-q-num">{index}</span>
        <span className="comp-q-focus">{FOCUS_LABEL[question.focus]}</span>
      </div>
      <div className="comp-q-prompt">{question.prompt}</div>

      {!answered ? (
        <>
          {question.options ? (
            <div className="comp-options">
              {question.options.map((opt) => (
                <button key={opt} className="comp-option" onClick={() => onAnswer(question.id, opt)}>
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <div className="comp-free">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={question.form === 'predict_failure'
                  ? 'This breaks when…'
                  : 'In your own words — phrasing does not matter.'}
                rows={3}
              />
              <Button variant="primary" onClick={() => onAnswer(question.id, draft)} disabled={!draft.trim()}>
                Answer
              </Button>
            </div>
          )}
          {/* Skipping is free and produces no follow-up. "I don't know" is a
              legitimate answer and identifies the gap more precisely than a
              guess would. */}
          <button className="comp-skip" onClick={() => onSkip(question.id)}>
            I don’t know
          </button>
        </>
      ) : (
        <div className="comp-result">
          {state.answer ? <div className="comp-your-answer">You said: {state.answer}</div> : null}

          {state.verdict === 'needs_model_judgement' ? (
            <div className="comp-pending">Checking your answer…</div>
          ) : null}

          {/* The explanation shows either way. A wrong answer that teaches
              nothing is just a score. */}
          <div className="comp-explanation">{question.explanation}</div>

          {state.verdict === 'differs' ? (
            <div className="comp-differs">
              <div className="comp-mine">{state.mine ?? question.explanation}</div>
              {/* The path that keeps this from being a grading tool: the agent
                  built this from its own reading of the requirement, and a
                  confident contradiction is evidence worth taking seriously. */}
              <button className="comp-dispute" onClick={() => onDispute(question.id)}>
                I think you’re wrong about this
              </button>
            </div>
          ) : null}

          {question.reference ? (
            <div className="comp-ref">{question.reference}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
