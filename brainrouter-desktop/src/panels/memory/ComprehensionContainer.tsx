/**
 * ADR-028 F7/G4 — the comprehension panel's data container.
 *
 * Built because the panel existed and nothing opened it — the exact pattern
 * this ADR is about, caught by asking "what does a user click to reach this?"
 * rather than by a test, since a component with no caller still compiles.
 *
 * The review is produced by the AGENT, not by the renderer: generating good
 * questions needs the model's view of what it just built and why. This
 * container asks for one and renders what comes back.
 */
import React, { useCallback, useState } from 'react';
import { ComprehensionPanel, type QuestionView, type AnswerState } from './ComprehensionPanel.js';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface ReviewPayload {
  subject: string;
  questions: QuestionView[];
}

export function ComprehensionContainer({ onStart }: { onStart?: () => void } = {}): React.ReactElement {
  const [subject, setSubject] = useState<string | null>(null);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Ask the AGENT for a review.
   *
   * The host cannot produce one — writing questions about consequences and
   * rejected alternatives needs the model that did the work. `onStart` submits
   * a turn; the questions arrive in the conversation, which is also where you
   * answer them and where the disagreement path lives.
   */
  const start = useCallback(async () => {
    if (onStart) { onStart(); return; }
    setBusy(true);
    try {
      const review = await bridgeQuery<ReviewPayload>('comprehension-start', {});
      if (review?.questions?.length) {
        setSubject(review.subject);
        setQuestions(review.questions);
        // A new review starts clean. Carrying answers across would let a
        // previous session's gaps colour this one.
        setAnswers({});
        setOutcome(null);
      }
    } catch {
      // Nothing to review is a normal state, not an error worth a banner.
    } finally {
      setBusy(false);
    }
  }, [onStart]);

  const answer = useCallback(async (questionId: string, given: string) => {
    // Optimistic, then judged. Free text needs the model (F7), so the row shows
    // "checking" rather than a verdict the renderer cannot honestly produce.
    setAnswers((a) => ({ ...a, [questionId]: { answer: given, verdict: 'needs_model_judgement' } }));
    try {
      const judged = await bridgeQuery<{ verdict: AnswerState['verdict']; mine?: string; outcome?: string }>(
        'comprehension-answer', { questionId, answer: given },
      );
      setAnswers((a) => ({
        ...a,
        [questionId]: { answer: given, verdict: judged?.verdict ?? 'needs_model_judgement', mine: judged?.mine },
      }));
      if (judged?.outcome) setOutcome(judged.outcome);
    } catch {
      setAnswers((a) => ({ ...a, [questionId]: { answer: given, verdict: 'needs_model_judgement' } }));
    }
  }, []);

  const skip = useCallback((questionId: string) => {
    setAnswers((a) => ({ ...a, [questionId]: { answer: null, verdict: 'skipped' } }));
    void bridgeQuery('comprehension-answer', { questionId, answer: null }).catch(() => {});
  }, []);

  const dispute = useCallback((questionId: string) => {
    // The path that turns a mark into a defect report. Sent to the agent so it
    // reconsiders its own answer rather than restating it.
    void bridgeQuery('comprehension-dispute', { questionId }).catch(() => {});
  }, []);

  return (
    <ComprehensionPanel
      subject={subject}
      questions={questions}
      answers={answers}
      outcome={outcome}
      busy={busy}
      onStart={() => void start()}
      onAnswer={(id, a) => void answer(id, a)}
      onSkip={skip}
      onDispute={dispute}
    />
  );
}
