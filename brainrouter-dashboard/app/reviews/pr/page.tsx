"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ManualReviewRunRequest } from "@kinqs/brainrouter-types";
import { AuthGuard } from "../../../components/AuthGuard";
import { EmptyState } from "../../../components/EmptyState";
import { PageHeader } from "../../../components/PageHeader";
import { PremiumCard } from "../../../components/PremiumCard";
import { StatusBadge } from "../../../components/Analytics";
import { AgentTraceGraph } from "../../../components/AgentTraceGraph";
import { adminApi, type ReviewJob, type ReviewPullRequestDetail } from "../../../lib/adminApi";
import { invalidateDashboardQueries, queryDashboard } from "../../../lib/dashboardQuery";
import { InlineLoading } from "../../../components/LoadingSpinner";
import {
  safeReviewsReturnPath,
  type ReviewRunLens,
} from "../reviewPresentation";
import { ReviewRunCard } from "./ReviewRunCard";
import { ReviewCodeFrame } from "../../../components/ReviewCodeFrame";
import { FilterSelect } from "../../../components/FilterSelect";
import { FINDING_PRODUCER_OPTIONS, countFindingsByProducer, filterFindingsByProducer, findingProducer, type FindingProducerFilter } from "../../../lib/review/reviewFindings";

function lensName(lens: ReviewJob["lens"]): string {
  if (lens === "security") return "Security review";
  if (lens === "code") return "Code review";
  return "Pentest";
}

function statusTone(status: string, blocking: number | null, error: string | null): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (error || (blocking ?? 0) > 0 || status === "failed" || status === "error") return "danger";
  if (status === "pending" || status === "queued" || status === "running") return "info";
  if (status === "done" || status === "completed" || status === "succeeded") return "ok";
  return "neutral";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : value;
}

function ReviewFindingsCard({ review }: { review: ReviewJob }) {
  const running = review.status === "pending" || review.status === "queued" || review.status === "running";
  // ADR-056 D-B8 — advisory static-design cards sit beside the model's; the
  // control only appears when both kinds exist, so a plain review stays plain.
  const [producerFilter, setProducerFilter] = useState<FindingProducerFilter>("all");
  const all = review.findingsDetail ?? [];
  const counts = countFindingsByProducer(all);
  const shown = filterFindingsByProducer(all, producerFilter);
  return (
    <PremiumCard level={2} className="review-detail__findings-card">
      <div className="settings-cardhead">
        <div><h3>{lensName(review.lens)}</h3><div className="settings-hint">{review.error ? review.error : running ? "Work is still in progress." : `Updated ${formatTimestamp(review.updatedAt)}`}</div></div>
        <StatusBadge tone={statusTone(review.status, review.blocking, review.error)}>{review.status}</StatusBadge>
      </div>
      <div className="review-detail__finding-summary">
        <span><strong>{review.findings ?? 0}</strong> findings</span>
        <span><strong>{review.blocking ?? 0}</strong> blocking</span>
        {counts.design > 0 && <span><strong>{counts.design}</strong> design (advisory)</span>}
        {counts.design > 0 && counts.model > 0 && (
          <FilterSelect
            value={producerFilter}
            onChange={(value) => setProducerFilter(value === "model" || value === "design" ? value : "all")}
            options={FINDING_PRODUCER_OPTIONS}
            allLabel="All producers"
            ariaLabel="Filter findings by producer"
          />
        )}
      </div>
      {shown.length ? (
        <div className="review-detail__findings">
          {shown.map((finding, index) => (
            <article key={`${finding.file}:${finding.line ?? 0}:${index}`}>
              <div className="review-detail__finding-head">
                <StatusBadge tone={finding.severity === "critical" || finding.severity === "high" ? "danger" : finding.severity === "medium" ? "warn" : "neutral"}>{finding.severity}</StatusBadge>
                <strong>{finding.title ?? finding.summary ?? "Finding"}</strong>
                {findingProducer(finding) === "design" && <StatusBadge tone="neutral">design · advisory</StatusBadge>}
              </div>
              <div className="settings-row__sub">{finding.file}{finding.line ? `:${finding.line}` : ""}{finding.cwe ? ` · ${finding.cwe}` : ""}{finding.preExisting ? " · Pre-existing" : ""}</div>
              {finding.summary && finding.summary !== finding.title && <p>{finding.summary}</p>}
              <ReviewCodeFrame finding={finding} />
            </article>
          ))}
        </div>
      ) : (
        <div className="settings-empty-inline">{running ? "Findings will appear as the review progresses." : all.length ? "No findings from this producer." : "No stored finding details."}</div>
      )}
    </PremiumCard>
  );
}

function Detail() {
  const search = useSearchParams();
  const repo = search.get("repo") ?? "";
  const number = Number(search.get("number"));
  const orgId = search.get("org") ?? undefined;
  const returnPath = safeReviewsReturnPath(search.get("from"));
  const [pr, setPr] = useState<ReviewPullRequestDetail | null>(null);
  const [canRun, setCanRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<ReviewRunLens | "">("");

  const validTarget = Boolean(repo && Number.isSafeInteger(number) && number > 0);
  const load = useCallback(async () => {
    if (!validTarget) {
      setLoading(false);
      return;
    }
    try {
      const result = await queryDashboard(`review-pr:${orgId ?? "default"}:${repo}#${number}`, () => adminApi.getReviewPr(repo, number, orgId), { ttlMs: 60_000 });
      setPr(result.pr);
      setCanRun(result.canRun);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load pull request");
    } finally {
      setLoading(false);
    }
  }, [validTarget, repo, number, orgId]);

  useEffect(() => { void load(); }, [load]);
  const hasActiveReview = Boolean(pr?.reviews.some((review) => review.status === "pending" || review.status === "queued" || review.status === "running"));
  useEffect(() => {
    if (!hasActiveReview || !validTarget) return;
    let cancelled = false;
    let timer = 0;
    let delay = 1000;
    const pollActivity = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = window.setTimeout(() => void pollActivity(), 5000);
        return;
      }
      let shouldContinue = true;
      try {
        const result = await adminApi.getReviewPrActivity(repo, number, orgId);
        if (cancelled) return;
        setPr((current) => current ? { ...current, reviews: result.reviews } : current);
        setCanRun(result.canRun);
        const stillActive = result.reviews.some((review) => review.status === "pending" || review.status === "queued" || review.status === "running");
        shouldContinue = stillActive;
      } catch {
        // A transient local activity read should not replace the loaded PR with an error screen.
      } finally {
        if (!cancelled && shouldContinue) {
          delay = Math.min(5000, delay + 1000);
          timer = window.setTimeout(() => void pollActivity(), delay);
        }
      }
    };
    timer = window.setTimeout(() => void pollActivity(), 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasActiveReview, validTarget, repo, number, orgId]);

  const run = async (request: ManualReviewRunRequest): Promise<boolean> => {
    if (request.lens === "pentest") return false;
    const lens = request.lens;
    setBusy(lens);
    setError("");
    try {
      await adminApi.runReview(request, orgId);
      invalidateDashboardQueries(`review-pr:${orgId ?? "default"}:${repo}#${number}`);
      invalidateDashboardQueries(`review-prs:${orgId ?? ""}`);
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to queue review");
      return false;
    } finally {
      setBusy("");
    }
  };

  const timeline = useMemo(() => (pr?.reviews ?? []).flatMap((review) => (review.progress ?? []).map((event) => ({
    ...event,
    reviewId: review.id,
    lens: review.lens,
  }))).sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts)), [pr?.reviews]);

  if (!validTarget) {
    return (
      <div className="settings-page review-detail">
        <PageHeader title="Pull request" description="Choose a pull request from the operational review list." />
        <Link href="/reviews" className="settings-link">Back to PR reviews</Link>
      </div>
    );
  }

  return (
    <div className="settings-page review-detail">
      <PageHeader title={pr ? `${pr.repo} #${pr.number}` : "Pull request"} description={pr?.title ?? "Review findings, checks, and progress."} />
      <div className="review-detail__breadcrumbs">
        <Link href={returnPath} className="settings-link">Back to PR reviews</Link>
        {pr?.url && <a className="settings-link" href={pr.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
      </div>
      {error && <div className="settings-note settings-note--error" role="alert">{error}</div>}

      {loading && !pr ? <InlineLoading label="Loading pull request…" /> : pr && (
        <div className="review-detail__grid">
          <main className="review-detail__main">
            <div className="review-detail__section-head"><div><span>Review output</span><h2>Findings</h2></div><span>{pr.reviews.length} run{pr.reviews.length === 1 ? "" : "s"}</span></div>
            {pr.reviews.length ? pr.reviews.map((review) => <ReviewFindingsCard key={review.id} review={review} />) : (
              <EmptyState title="No reviews yet" description="Run Security review, Code review, or both. Automatic repository enrollment is not required for an on-demand review." />
            )}
            <div className="review-detail__section-head"><div><span>Review execution</span><h2>Agent Trace</h2></div><span>Live</span></div>
            <AgentTraceGraph reviews={pr.reviews} />
          </main>

          <aside className="review-detail__aside" aria-label="Pull request review metadata">
            <ReviewRunCard
              repo={repo}
              prNumber={number}
              canRun={canRun}
              availability={pr.availability}
              busy={busy}
              onRun={run}
            />

            <PremiumCard level={2} className="review-detail__metadata-card">
              <div className="settings-cardhead"><div><h3>Repository</h3><div className="settings-hint">Current pull request metadata</div></div><StatusBadge tone={pr.availability.autoReviewEnabled ? "ok" : "neutral"}>{pr.availability.autoReviewEnabled ? "Automatic" : "On demand"}</StatusBadge></div>
              <dl className="review-detail__metadata">
                <div><dt>Repository</dt><dd>{pr.repo}</dd></div>
                <div><dt>Author</dt><dd>{pr.author ?? "Unknown"}</dd></div>
                <div><dt>Branch</dt><dd>{pr.branch ?? "Unknown"}</dd></div>
                <div><dt>Head</dt><dd><code>{pr.headSha?.slice(0, 12) ?? "Unavailable"}</code></dd></div>
              </dl>
            </PremiumCard>

            <PremiumCard level={2} className="review-detail__checks-card">
              <div className="settings-cardhead"><div><h3>Checks</h3><div className="settings-hint">GitHub state for the current head commit</div></div><span className="settings-badge settings-badge--muted">{pr.checks.length}</span></div>
              {pr.checks.length ? pr.checks.map((check, index) => {
                const state = check.conclusion ?? check.status ?? "pending";
                const content = <><span className="review-detail__check-name">{check.name ?? "Check"}</span><StatusBadge tone={state === "success" ? "ok" : state === "failure" ? "danger" : "neutral"}>{state}</StatusBadge></>;
                return check.html_url ? <a className="review-detail__check" key={check.id ?? index} href={check.html_url} target="_blank" rel="noreferrer">{content}</a> : <div className="review-detail__check" key={check.id ?? index}>{content}</div>;
              }) : <div className="settings-empty-inline">No check runs yet.</div>}
            </PremiumCard>

            <PremiumCard level={2} className="review-detail__timeline-card">
              <div className="settings-cardhead"><div><h3>Timeline</h3><div className="settings-hint">Latest review work first</div></div>{timeline.length > 0 && <span className="settings-badge settings-badge--muted">{timeline.length}</span>}</div>
              {timeline.length ? <ol className="review-detail__timeline">{timeline.map((event, index) => (
                <li key={`${event.reviewId}:${event.ts}:${index}`}>
                  <span className="review-detail__timeline-dot" aria-hidden />
                  <div><strong>{event.msg}</strong><span>{lensName(event.lens)} · {formatTimestamp(event.ts)}</span></div>
                </li>
              ))}</ol> : <div className="settings-empty-inline">No progress events yet.</div>}
            </PremiumCard>
          </aside>
        </div>
      )}
    </div>
  );
}

export default function ReviewDetailPage() {
  return <AuthGuard><Detail /></AuthGuard>;
}
