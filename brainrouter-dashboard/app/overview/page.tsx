"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type ReviewSummary } from "../../lib/adminApi";
import { queryDashboard } from "../../lib/dashboardQuery";

const EMPTY: ReviewSummary = {
  periodDays: 30,
  metrics: { securityScore: 100, openIssues: 0, issuesFound: 0, fixRate: 100, prsReviewed: 0, pentests: 0 },
  severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  verdicts: { approved: 0, commented: 0, changesRequested: 0 },
  history: [],
  repositories: [],
};

function Overview() {
  const [summary, setSummary] = useState<ReviewSummary>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await queryDashboard("overview:review-summary:30", () => adminApi.reviewSummary(undefined, 30), { ttlMs: 30_000 }));
      setError("");
    } catch (caught) {
      setSummary(EMPTY);
      setError(caught instanceof Error ? caught.message : "Workspace activity could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const highPriority = summary.severity.critical + summary.severity.high;
  const repositories = useMemo(
    () => [...summary.repositories].sort((left, right) => right.prs - left.prs).slice(0, 5),
    [summary.repositories],
  );
  const recent = useMemo(
    () => summary.history.slice(-4).reverse().map((day) => ({
      ...day,
      findings: day.critical + day.high + day.medium + day.low,
    })),
    [summary.history],
  );

  return (
    <div className="settings-page overview-compact">
      <PageHeader title="Workspace overview" description="The work that needs attention, recent review activity, and active repositories.">
        <Link href="/chat"><PremiumButton variant="primary">New task</PremiumButton></Link>
      </PageHeader>

      {error && <div className="settings-note settings-note--error" role="alert">{error} <button type="button" className="settings-action" onClick={() => void load()}>Try again</button></div>}

      <section className="overview-compact-grid" aria-label="Workspace status">
        <article className="overview-attention-panel">
          <header><span>Attention</span><Link href="/reviews">Open reviews <span aria-hidden>→</span></Link></header>
          {loading ? <div className="overview-compact-empty">Loading workspace status…</div>
            : summary.metrics.openIssues > 0 ? (
              <div className="overview-attention-state" data-state="attention">
                <strong>{summary.metrics.openIssues}</strong>
                <div><b>Open review item{summary.metrics.openIssues === 1 ? "" : "s"}</b><span>{highPriority} critical or high priority · action recommended</span></div>
              </div>
            ) : (
              <div className="overview-attention-state" data-state="clear">
                <strong>✓</strong>
                <div><b>No open review items</b><span>Reviewed work is clear for the last 30 days.</span></div>
              </div>
            )}
          <div className="overview-attention-breakdown">
            <span><b>{summary.severity.critical}</b> Critical</span>
            <span><b>{summary.severity.high}</b> High</span>
            <span><b>{summary.severity.medium}</b> Medium</span>
          </div>
        </article>

        <article className="overview-recent-panel">
          <header><span>Recent work</span><Link href="/fleet">View activity <span aria-hidden>→</span></Link></header>
          {loading ? <div className="overview-compact-empty">Loading recent work…</div>
            : recent.length === 0 ? <div className="overview-compact-empty">No review activity yet. Start a task or connect a repository.</div>
              : <div className="overview-recent-list">{recent.map((day) => (
                <div key={day.date}><time dateTime={day.date}>{new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span>{day.findings ? `${day.findings} finding${day.findings === 1 ? "" : "s"} recorded` : "No findings recorded"}</span></div>
              ))}</div>}
        </article>
      </section>

      <section className="overview-metric-strip" aria-label="Last 30 days">
        <div><span>Reviews</span><strong>{summary.metrics.prsReviewed}</strong><small>pull requests</small></div>
        <div><span>Quality</span><strong>{summary.metrics.securityScore}</strong><small>workspace score</small></div>
        <div><span>Resolved</span><strong>{summary.metrics.fixRate}%</strong><small>completion rate</small></div>
        <div><span>New items</span><strong>{summary.metrics.issuesFound}</strong><small>last 30 days</small></div>
      </section>

      <section className="overview-repositories">
        <header><div><span>Repositories</span><h2>Most active workspaces</h2></div><Link href="/projects">All projects <span aria-hidden>→</span></Link></header>
        {loading ? <div className="overview-compact-empty">Loading repositories…</div>
          : repositories.length === 0 ? (
            <div className="overview-repository-empty"><span>No repository activity yet.</span><Link href="/integrations">Connect a repository</Link></div>
          ) : <div className="overview-repository-list">{repositories.map((repository) => (
            <div key={repository.repository}>
              <strong>{repository.repository}</strong>
              <span>{repository.prs} review{repository.prs === 1 ? "" : "s"}</span>
              <span>{repository.findings} found</span>
              <span>{repository.addressed} resolved</span>
              <Link href={`/reviews?repo=${encodeURIComponent(repository.repository)}`} aria-label={`Open reviews for ${repository.repository}`}>→</Link>
            </div>
          ))}</div>}
      </section>
    </div>
  );
}

export default function OverviewPage() {
  return <AuthGuard><Overview /></AuthGuard>;
}
