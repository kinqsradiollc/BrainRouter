"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { AreaChart, DataTable, Donut, LineChart, MetricTile, StackedBar } from "../../components/Analytics";
import { adminApi, type ReviewSummary } from "../../lib/adminApi";

const EMPTY: ReviewSummary = { periodDays: 30, metrics: { securityScore: 100, openIssues: 0, issuesFound: 0, fixRate: 100, prsReviewed: 0, pentests: 0 }, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, verdicts: { approved: 0, commented: 0, changesRequested: 0 }, history: [], repositories: [] };

function Overview() {
  const [summary, setSummary] = useState<ReviewSummary>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(30);
  const load = useCallback(async () => { setLoading(true); try { setSummary(await adminApi.reviewSummary(undefined, period)); } catch { setSummary(EMPTY); } finally { setLoading(false); } }, [period]);
  useEffect(() => { void load(); }, [load]);
  const addressed = useMemo(() => summary.history.map((day) => Math.max(0, 100 - (day.critical * 18 + day.high * 8 + day.medium * 3 + day.low))).slice(-12), [summary]);
  return <div className="settings-page">
    <PageHeader title="Workspace overview" description="Start agent work and check the systems that need attention across this workspace.">
      <select aria-label="Date range" className="settings-input" value={period} onChange={(e) => setPeriod(Number(e.target.value))} style={{ width: 142 }}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
      <Link href="/projects"><PremiumButton variant="ghost">Projects</PremiumButton></Link>
      <Link href="/chat"><PremiumButton variant="primary">New agent task</PremiumButton></Link>
    </PageHeader>
    <section className="overview-start-grid" aria-labelledby="overview-start-title">
      <Link href="/chat" className="overview-start-primary" data-tone="build">
        <span className="overview-start-eyebrow"><i /> Start here</span>
        <div>
          <h2 id="overview-start-title">What should BrainRouter help you move forward?</h2>
          <p>Begin with an outcome. The workbench keeps your project, tools, plan, and useful context together through the result.</p>
        </div>
        <b>New agent task <span aria-hidden>→</span></b>
        <div className="overview-start-route" aria-hidden><i /><i /><i /><i /></div>
      </Link>
      <div className="overview-start-paths" aria-label="Other workspace areas">
        <Link href="/knowledge" data-tone="knowledge"><span>Context</span><strong>Knowledge</strong><small>See what BrainRouter remembers and why.</small><b>Explore <i aria-hidden>→</i></b></Link>
        <Link href="/integrations" data-tone="connect"><span>Sources</span><strong>Connections</strong><small>Manage repositories and connected systems.</small><b>Configure <i aria-hidden>→</i></b></Link>
        <Link href="/fleet" data-tone="automation"><span>Runs</span><strong>Automation</strong><small>See agents, hooks, and active work.</small><b>Monitor <i aria-hidden>→</i></b></Link>
      </div>
    </section>
    <section className="overview-context-guide">
      <header><span>Useful context</span><div><h2>Continue without repeating the setup.</h2><p>Open the part of workspace knowledge you need, or inspect why it appeared.</p></div><Link href="/knowledge">Open all knowledge <span aria-hidden>→</span></Link></header>
      <div className="overview-context-links">
        <Link href="/memories"><strong>Saved knowledge</strong><small>Decisions, preferences, and lessons</small></Link>
        <Link href="/sources"><strong>Connected sources</strong><small>Documents and conversations</small></Link>
        <Link href="/working-memory"><strong>Current task context</strong><small>What BrainRouter is using now</small></Link>
        <Link href="/recall-inspector"><strong>Recall details</strong><small>Understand the context behind an answer</small></Link>
      </div>
    </section>
    <div className="overview-section-head"><div><span>Work quality</span><h2>What needs attention</h2></div><p>{summary.metrics.openIssues ? `${summary.metrics.openIssues} item${summary.metrics.openIssues === 1 ? "" : "s"} need attention across reviewed work.` : "Reviewed work has no open items in this period."}</p></div>
    <div className="analytics-grid kpi-row" style={{ marginTop: 16 }}>
      <MetricTile label="Quality score" value={summary.metrics.securityScore} delta={summary.metrics.securityScore >= 80 ? "On track" : "Needs attention"} trend={summary.metrics.securityScore >= 80 ? "up" : "down"} />
      <MetricTile label="Needs attention" value={summary.metrics.openIssues} delta="Still open" trend={summary.metrics.openIssues ? "down" : "up"} />
      <MetricTile label="New items" value={summary.metrics.issuesFound} delta={`Last ${period} days`} trend="flat" />
      <MetricTile label="Resolved" value={`${summary.metrics.fixRate}%`} delta="Completion rate" trend="up" />
      <MetricTile label="Reviews completed" value={summary.metrics.prsReviewed} delta="Pull requests" trend="flat" />
    </div>
    <div className="analytics-grid analytics-split" style={{ marginTop: 16 }}>
      <section className="analytics-panel"><h2>Items found over time</h2><AreaChart data={summary.history} /></section>
      <section className="analytics-panel"><h2>What needs attention</h2><Donut values={summary.severity} /></section>
    </div>
    <div className="analytics-grid analytics-bottom" style={{ marginTop: 16 }}>
      <section className="analytics-panel"><h2>Review outcomes</h2><StackedBar values={summary.verdicts} /></section>
      <section className="analytics-panel"><h2>Resolution progress</h2><LineChart points={addressed.length ? addressed : [100]} /></section>
      <section className="analytics-panel"><h2>Most active repositories</h2><DataTable headers={["Repository", "Reviews", "Found", "Resolved"]}>{summary.repositories.length ? summary.repositories.map((repo) => <tr key={repo.repository}><td>{repo.repository}</td><td>{repo.prs}</td><td>{repo.findings}</td><td>{repo.addressed}</td></tr>) : <tr><td colSpan={4}>{loading ? "Loading activity…" : "No review activity yet."}</td></tr>}</DataTable></section>
    </div>
  </div>;
}

export default function OverviewPage() { return <AuthGuard><Overview /></AuthGuard>; }
