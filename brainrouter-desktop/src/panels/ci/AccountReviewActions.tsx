import { useState } from 'react';
import { manualDeepReviewLimitLines } from '@kinqs/brainrouter-types/review';
import { Button } from '../../components/primitives/Button.js';
import { Icon } from '../../icons.js';
import {
  pullRequestReviewTarget,
  reviewActionAvailability,
  type PullRequestReviewTarget,
  type ReviewActionAccess,
  type ReviewExecutionMode,
} from '../../settings/reviews/reviewPresentation.js';

export type AccountReviewLens = 'security' | 'code';
export type AccountReviewNotice = { target: string; text: string; error: boolean } | null;

interface AccountReviewActionsProps {
  pr: { number?: number; url?: string };
  access: ReviewActionAccess;
  running: string | null;
  notice: AccountReviewNotice;
  onRun: (
    target: PullRequestReviewTarget,
    lens: AccountReviewLens,
    mode: ReviewExecutionMode,
    limitsAccepted: boolean,
  ) => void;
  compact?: boolean;
}

export function AccountReviewActions({
  pr,
  access,
  running,
  notice,
  onRun,
  compact = false,
}: AccountReviewActionsProps): React.ReactElement {
  const [mode, setMode] = useState<ReviewExecutionMode>('diff');
  const [limitsAccepted, setLimitsAccepted] = useState(false);
  const target = pullRequestReviewTarget(pr.url, pr.number);
  const targetKey = target ? `${target.repo}#${target.prNumber}` : '';
  const availability = reviewActionAvailability(access, target);
  const blocked = !availability.enabled || !!running || (mode === 'deep' && !limitsAccepted);
  const targetNotice = notice?.target === targetKey ? notice : null;
  const runningPrefix = `${targetKey}:${mode}:`;
  const startReview = (lens: AccountReviewLens): void => {
    if (!target) return;
    onRun(target, lens, mode, limitsAccepted);
    if (mode === 'deep') setLimitsAccepted(false);
  };

  return (
    <div className={`ci-account-review${compact ? ' compact' : ''}`}>
      <div className="ci-account-review-head">
        <span className="ci-account-review-title">BrainRouter reviews</span>
        {access.signedIn && !access.loading ? <span className={`ci-account-review-access${access.canRun ? ' allowed' : ''}`}>{access.canRun ? 'Allowed' : 'Read only'}</span> : null}
      </div>
      <div className="ci-account-review-mode" role="group" aria-label="Review scope">
        {(['diff', 'deep'] as const).map((option) => (
          <button
            type="button"
            key={option}
            className={mode === option ? 'active' : ''}
            aria-pressed={mode === option}
            disabled={Boolean(running)}
            onClick={() => {
              setMode(option);
              setLimitsAccepted(false);
            }}
          >
            {option === 'diff' ? 'Diff' : 'Deep'}
          </button>
        ))}
      </div>
      {mode === 'deep' ? (
        <div className="ci-account-review-deep" aria-label="Deep-review limits">
          <div className="ci-account-review-deep-title"><strong>Bounded whole repository</strong><span>Manual only</span></div>
          <dl>
            {manualDeepReviewLimitLines().map((line) => (
              <div key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></div>
            ))}
          </dl>
          <p>Preflight stops before model work when limits are exceeded. Coverage keeps unsupported and unindexed files visible. This is not a pentest.</p>
          <label>
            <input type="checkbox" checked={limitsAccepted} disabled={Boolean(running)} onChange={(event) => setLimitsAccepted(event.target.checked)} />
            <span>I accept these limits for this manual run.</span>
          </label>
        </div>
      ) : null}
      <div className="ci-account-review-actions">
        <Button disabled={blocked} className={running === `${runningPrefix}security` ? 'is-busy' : ''} onClick={() => startReview('security')}>
          {running === `${runningPrefix}security` ? <span className="spinner sm" /> : <Icon name="shield" size={12} />}Security review
        </Button>
        <Button disabled={blocked} className={running === `${runningPrefix}code` ? 'is-busy' : ''} onClick={() => startReview('code')}>
          {running === `${runningPrefix}code` ? <span className="spinner sm" /> : <Icon name="code" size={12} />}Code review
        </Button>
      </div>
      <div className={`ci-account-review-help${targetNotice?.error ? ' error' : ''}`} role={targetNotice?.error ? 'alert' : undefined} aria-live="polite">
        {targetNotice?.text ?? (!availability.enabled ? availability.help : mode === 'deep' && !limitsAccepted ? 'Accept the displayed limits to enable this one manual run.' : availability.help)}
      </div>
    </div>
  );
}
