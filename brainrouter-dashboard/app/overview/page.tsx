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
    <PageHeader title="Security dashboard" description="A clear view of review posture, findings, and remediation momentum.">
      <select aria-label="Date range" className="settings-input" value={period} onChange={(e) => setPeriod(Number(e.target.value))} style={{ width: 142 }}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
      <Link href="/pentests"><PremiumButton variant="primary">+ New Pentest</PremiumButton></Link>
    </PageHeader>
    <div className="insight-bar"><strong>In a nutshell:</strong> {summary.metrics.openIssues ? `${summary.metrics.openIssues} open finding${summary.metrics.openIssues === 1 ? "" : "s"} need attention across your reviewed work.` : "No open findings in the selected period — keep review coverage running."}</div>
    <div className="analytics-grid kpi-row" style={{ marginTop: 16 }}>
      <MetricTile label="Security score" value={summary.metrics.securityScore} delta={summary.metrics.securityScore >= 80 ? "Healthy" : "Needs attention"} trend={summary.metrics.securityScore >= 80 ? "up" : "down"} />
      <MetricTile label="Open issues" value={summary.metrics.openIssues} delta="Current backlog" trend={summary.metrics.openIssues ? "down" : "up"} />
      <MetricTile label="Issues found" value={summary.metrics.issuesFound} delta={`${period} day period`} trend="flat" />
      <MetricTile label="Fix rate" value={`${summary.metrics.fixRate}%`} delta="Addressed" trend="up" />
      <MetricTile label="PRs reviewed" value={summary.metrics.prsReviewed} delta="Automated reviews" trend="flat" />
      <MetricTile label="Pentests" value={summary.metrics.pentests} delta="Completed runs" trend="flat" />
    </div>
    <div className="analytics-grid analytics-split" style={{ marginTop: 16 }}>
      <section className="analytics-panel"><h2>Issues over time</h2><AreaChart data={summary.history} /></section>
      <section className="analytics-panel"><h2>Open issues by severity</h2><Donut values={summary.severity} /></section>
    </div>
    <div className="analytics-grid analytics-bottom" style={{ marginTop: 16 }}>
      <section className="analytics-panel"><h2>PRs reviewed</h2><StackedBar values={summary.verdicts} /></section>
      <section className="analytics-panel"><h2>Findings addressed rate</h2><LineChart points={addressed.length ? addressed : [100]} /></section>
      <section className="analytics-panel"><h2>Top repositories</h2><DataTable headers={["Repository", "PRs", "Findings", "Addressed"]}>{summary.repositories.length ? summary.repositories.map((repo) => <tr key={repo.repository}><td>{repo.repository}</td><td>{repo.prs}</td><td>{repo.findings}</td><td>{repo.addressed}</td></tr>) : <tr><td colSpan={4}>{loading ? "Loading analytics…" : "No review activity yet."}</td></tr>}</DataTable></section>
    </div>
  </div>;
}

export default function OverviewPage() { return <AuthGuard><Overview /></AuthGuard>; }
