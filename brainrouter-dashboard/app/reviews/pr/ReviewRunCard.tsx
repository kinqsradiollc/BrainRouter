"use client";

import { useState } from "react";
import type {
  ManualReviewRunRequest,
  RepositoryReviewAvailability,
} from "@kinqs/brainrouter-types";
import { manualDeepReviewLimitLines } from "@kinqs/brainrouter-types/review";
import { PremiumButton } from "../../../components/PremiumButton";
import { PremiumCard } from "../../../components/PremiumCard";
import {
  REVIEW_ACTION_LABELS,
  manualReviewRunRequest,
  reviewActionPresentation,
  type ReviewExecutionMode,
  type ReviewRunLens,
} from "../reviewPresentation";

interface ReviewRunCardProps {
  repo: string;
  prNumber: number;
  canRun: boolean;
  availability: RepositoryReviewAvailability;
  busy: ReviewRunLens | "";
  onRun: (request: ManualReviewRunRequest) => Promise<boolean>;
}

export function ReviewRunCard({
  repo,
  prNumber,
  canRun,
  availability,
  busy,
  onRun,
}: ReviewRunCardProps): React.ReactElement {
  const [executionMode, setExecutionMode] = useState<ReviewExecutionMode>("diff");
  const [deepLimitsAccepted, setDeepLimitsAccepted] = useState(false);
  const action = reviewActionPresentation(canRun, availability, Boolean(busy));
  const runEnabled = action.enabled && (executionMode === "diff" || deepLimitsAccepted);
  const runHelp = !action.enabled
    ? action.help
    : executionMode === "deep" && !deepLimitsAccepted
      ? "Accept the displayed limits to enable this one manual run."
      : action.help;

  const run = async (lens: ReviewRunLens): Promise<void> => {
    const started = await onRun(
      manualReviewRunRequest(repo, prNumber, lens, executionMode, deepLimitsAccepted),
    );
    if (started && executionMode === "deep") setDeepLimitsAccepted(false);
  };

  return (
    <PremiumCard level={2} className="review-detail__run-card">
      <div className="settings-cardhead"><div><h3>Run review</h3><div className="settings-hint">Uses organization policy and posts the result to this pull request.</div></div></div>
      <fieldset className="review-detail__mode">
        <legend>Review scope</legend>
        <label>
          <input
            type="radio"
            name="review-execution-mode"
            checked={executionMode === "diff"}
            disabled={Boolean(busy)}
            onChange={() => {
              setExecutionMode("diff");
              setDeepLimitsAccepted(false);
            }}
          />
          <span><strong>Diff</strong><small>Changed code and related context</small></span>
        </label>
        <label>
          <input
            type="radio"
            name="review-execution-mode"
            checked={executionMode === "deep"}
            disabled={Boolean(busy)}
            onChange={() => {
              setExecutionMode("deep");
              setDeepLimitsAccepted(false);
            }}
          />
          <span><strong>Deep</strong><small>Bounded whole repository</small></span>
        </label>
      </fieldset>
      {executionMode === "deep" && (
        <div className="review-detail__deep" aria-label="Deep-review limits">
          <div className="review-detail__deep-title">
            <strong>Bounded whole repository</strong>
            <span>Manual only</span>
          </div>
          <dl>
            {manualDeepReviewLimitLines().map((line) => (
              <div key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></div>
            ))}
          </dl>
          <p>Preflight stops before model work when the repository exceeds these limits. Unsupported or unindexed files remain visible as coverage limitations. This is not a pentest.</p>
          <label className="review-detail__deep-accept">
            <input
              type="checkbox"
              checked={deepLimitsAccepted}
              disabled={Boolean(busy)}
              onChange={(event) => setDeepLimitsAccepted(event.target.checked)}
            />
            <span>I accept these limits for this manual run.</span>
          </label>
        </div>
      )}
      <div className="review-detail__run-actions">
        <PremiumButton size="small" title={runHelp} disabled={!runEnabled} onClick={() => void run("security")}>{busy === "security" ? "Queuing…" : REVIEW_ACTION_LABELS.security}</PremiumButton>
        <PremiumButton size="small" title={runHelp} disabled={!runEnabled} onClick={() => void run("code")}>{busy === "code" ? "Queuing…" : REVIEW_ACTION_LABELS.code}</PremiumButton>
        <PremiumButton size="small" variant="primary" title={runHelp} disabled={!runEnabled} onClick={() => void run("both")}>{busy === "both" ? "Queuing…" : REVIEW_ACTION_LABELS.both}</PremiumButton>
      </div>
      <p className="review-detail__run-help">{runHelp}</p>
    </PremiumCard>
  );
}
