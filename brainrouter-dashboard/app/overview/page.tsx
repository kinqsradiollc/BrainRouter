"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PremiumButton } from "../../components/PremiumButton";
import { AreaChart, Donut, LineChart, MetricTile, OpenFixedChart, SeverityBadge, StackedBar } from "../../components/Analytics";
import {
  adminApi, authFetch,
  type ReviewIssue, type ReviewJob, type ReviewSummary,
} from "../../lib/adminApi";
import { queryDashboard } from "../../lib/dashboardQuery";
import { InlineLoading } from "../../components/LoadingSpinner";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { useAuth } from "../../components/AuthProvider";
import { EarthGlobe } from "../../components/EarthGlobe";
import { ProductOrbit } from "../../components/ProductOrbit";
import { OVERVIEW_ACTIONS, PRODUCT_LOOP } from "../../lib/homeProductStory";
import styles from "./overview.module.css";

const EMPTY: ReviewSummary = {
  periodDays: 30,
  metrics: { securityScore: 100, openIssues: 0, issuesFound: 0, fixRate: 100, prsReviewed: 0, pentests: 0 },
  severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  verdicts: { approved: 0, commented: 0, changesRequested: 0 },
  history: [],
  repositories: [],
  contributors: [],
};
const EMPTY_ACTIVITY: ReviewSummary = { ...EMPTY, periodDays: 365 };

const PERIODS = [30, 7] as const;
type Period = (typeof PERIODS)[number];

/** Newest-CVE row for the threat-intel panel — a subset of the catalog shape. */
interface CveFeedItem {
  cveId: string;
  summary: string;
  severity: string | null;
  cvssScore: number | null;
  publishedAt: string | null;
}

/** A grey ramp for the vulnerability-type donut (monochrome, distinct steps). */
const TYPE_RAMP = ["#8A9199", "#6B7178", "#565C63", "#42474D", "#9CA3AB", "#767C83"] as const;

function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function firstNameOf(displayName?: string, email?: string): string {
  const name = displayName?.trim();
  if (name) return name.split(/\s+/)[0];
  const local = email?.split("@")[0]?.trim();
  return local || "there";
}

/** Compact "today / 2d ago / Jul 3" relative label for a publish timestamp. */
function relativeDay(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.valueOf())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Bucket a finding into a human vulnerability-type label from CWE or its title. */
function vulnTypeOf(finding: { cwe?: string; title?: string }): string {
  const cwe = finding.cwe?.trim();
  if (cwe) return cwe.toUpperCase().startsWith("CWE-") ? cwe.toUpperCase() : `CWE-${cwe.replace(/\D/g, "")}`;
  const title = (finding.title ?? "").toLowerCase();
  if (/inject|sqli|xss|script/.test(title)) return "Injection";
  if (/auth|credential|password|token|secret/.test(title)) return "Auth & secrets";
  if (/path|traversal|ssrf|redirect/.test(title)) return "Access control";
  if (/crypto|hash|random|tls|ssl/.test(title)) return "Cryptography";
  if (/deps|dependency|version|outdated|cve/.test(title)) return "Dependencies";
  return "Other";
}

/**
 * Count up to a numeric target over ~700ms on first mount. Honors reduced
 * motion (jumps straight to the value) and re-animates when the target changes.
 */
function useCountUp(target: number, enabled = true): number {
  const [display, setDisplay] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) { setDisplay(target); return; }
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || target === 0) { setDisplay(target); return; }
    const from = 0;
    const start = performance.now();
    const duration = 700;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return display;
}

/** ISO timestamp for `days` ago — used to window the global CVE catalog. */
function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function Overview() {
  const { activeOrgId } = useActiveOrg();
  const { user } = useAuth();

  const [days, setDays] = useState<Period>(30);
  const [summary, setSummary] = useState<ReviewSummary>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [issues, setIssues] = useState<ReviewIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [activitySummary, setActivitySummary] = useState<ReviewSummary>(EMPTY_ACTIVITY);
  const [activityJobs, setActivityJobs] = useState<ReviewJob[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  const [cveItems, setCveItems] = useState<CveFeedItem[]>([]);
  const [cveTotal, setCveTotal] = useState(0);
  const [cve7d, setCve7d] = useState<number | null>(null);
  const [cve30d, setCve30d] = useState<number | null>(null);
  const [cveLoading, setCveLoading] = useState(true);

  const [issuesTab, setIssuesTab] = useState<"all">("all");
  const [repoTab, setRepoTab] = useState<"repos" | "contributors">("repos");

  // Greeting depends on the client clock; resolve after mount so the server-
  // rendered markup and first client paint agree (no hydration mismatch).
  const [greeting, setGreeting] = useState("Welcome back");
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setGreeting(greetingFor(new Date().getHours())); setMounted(true); }, []);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      // Scope to the active workspace; the cache key carries the org + period so
      // switching workspaces or periods never reuses another scope's figures.
      setSummary(await queryDashboard(
        `overview:review-summary:${days}:${activeOrgId}`,
        () => adminApi.reviewSummary(activeOrgId || undefined, days),
        { ttlMs: 30_000 },
      ));
      setError("");
    } catch (caught) {
      setSummary(EMPTY);
      setError(caught instanceof Error ? caught.message : "Workspace activity could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [activeOrgId, days]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);

  // Top open issues + vulnerability-type mix (org-scoped).
  const loadIssues = useCallback(async () => {
    setIssuesLoading(true);
    try {
      const result = await queryDashboard(
        `overview:issues:${activeOrgId}`,
        () => adminApi.listReviewIssues({ limit: 60, status: "open", sort: "newest" }, activeOrgId || undefined),
        { ttlMs: 30_000 },
      );
      setIssues(result.issues);
    } catch {
      setIssues([]);
    } finally {
      setIssuesLoading(false);
    }
  }, [activeOrgId]);
  useEffect(() => { void loadIssues(); }, [loadIssues]);

  // A separate 12-month rollup keeps the activity calendar stable while the
  // period control above changes review charts between 7 and 30 days.
  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const [activity, jobs] = await Promise.all([
        queryDashboard(
          `overview:activity-summary:365:${activeOrgId}`,
          () => adminApi.reviewSummary(activeOrgId || undefined, 365),
          { ttlMs: 60_000 },
        ),
        queryDashboard(
          `overview:activity-jobs:${activeOrgId}`,
          () => adminApi.listReviewJobs(activeOrgId || undefined, 100),
          { ttlMs: 30_000 },
        ),
      ]);
      setActivitySummary(activity);
      setActivityJobs(jobs.reviews);
    } catch {
      setActivitySummary(EMPTY_ACTIVITY);
      setActivityJobs([]);
    } finally {
      setActivityLoading(false);
    }
  }, [activeOrgId]);
  useEffect(() => { void loadActivity(); }, [loadActivity]);

  // Threat-intel feed is GLOBAL (CVE data is not org-scoped); load the newest
  // catalog rows plus 7-day / 30-day detection counts (windowed by modifiedSince).
  const loadCve = useCallback(async () => {
    setCveLoading(true);
    try {
      const [feed, week, month] = await Promise.all([
        queryDashboard(
          "overview:cve-feed",
          () => authFetch<{ items: CveFeedItem[]; total: number }>("/api/vulnerabilities?limit=12"),
          { ttlMs: 300_000 },
        ),
        queryDashboard(
          "overview:cve-7d",
          () => authFetch<{ total: number }>(`/api/vulnerabilities?limit=1&modifiedSince=${encodeURIComponent(sinceIso(7))}`),
          { ttlMs: 300_000 },
        ),
        queryDashboard(
          "overview:cve-30d",
          () => authFetch<{ total: number }>(`/api/vulnerabilities?limit=1&modifiedSince=${encodeURIComponent(sinceIso(30))}`),
          { ttlMs: 300_000 },
        ),
      ]);
      const newest = [...feed.items]
        .sort((left, right) => (right.publishedAt ? Date.parse(right.publishedAt) : 0) - (left.publishedAt ? Date.parse(left.publishedAt) : 0))
        .slice(0, 6);
      setCveItems(newest);
      setCveTotal(feed.total);
      setCve7d(week.total);
      setCve30d(month.total);
    } catch {
      setCveItems([]);
      setCveTotal(0);
      setCve7d(null);
      setCve30d(null);
    } finally {
      setCveLoading(false);
    }
  }, []);
  useEffect(() => { void loadCve(); }, [loadCve]);

  const { metrics, severity, verdicts } = summary;

  const repositories = useMemo(
    () => [...summary.repositories].sort((left, right) => right.prs - left.prs),
    [summary.repositories],
  );
  const contributors = useMemo(
    () => [...(summary.contributors ?? [])].sort((left, right) => right.findingsFixed - left.findingsFixed || right.prs - left.prs || right.commits - left.commits),
    [summary.contributors],
  );

  // Per-repository addressed rate — the LineChart's series over the period.
  const addressedRate = useMemo(
    () => summary.repositories
      .filter((repo) => repo.findings > 0)
      .map((repo) => Math.round((repo.addressed / repo.findings) * 100)),
    [summary.repositories],
  );

  // Vulnerability-type buckets from the open findings, largest first.
  const vulnTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      const key = vulnTypeOf(issue.finding);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [issues]);
  const vulnTotal = vulnTypes.reduce((sum, [, value]) => sum + value, 0);

  const topIssues = useMemo(
    () => [...issues]
      .sort((a, b) => severityWeight(b.finding.severity) - severityWeight(a.finding.severity))
      .slice(0, 4),
    [issues],
  );

  const recentActivity = useMemo(
    () => [...activityJobs]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 6),
    [activityJobs],
  );

  // GitHub-style 52-week heatmap across every verification execution. PR
  // reviews and tests stay visible as distinct source totals and tooltips.
  const heatmap = useMemo(() => buildHeatmap(activitySummary.history), [activitySummary.history]);

  const animate = mounted && !loading;
  const score = useCountUp(metrics.securityScore, animate);
  const open = useCountUp(metrics.openIssues, animate);
  const found = useCountUp(metrics.issuesFound, animate);
  const fix = useCountUp(metrics.fixRate, animate);
  const prs = useCountUp(metrics.prsReviewed, animate);
  const pentests = useCountUp(metrics.pentests, animate);

  const nutshell = metrics.issuesFound === 0 && metrics.prsReviewed === 0
    ? <>No review activity in the last {days} days yet — start a task or connect a repository.</>
    : <><b>{metrics.issuesFound}</b> issue{metrics.issuesFound === 1 ? "" : "s"} discovered · <b>{metrics.prsReviewed}</b> PR{metrics.prsReviewed === 1 ? "" : "s"} reviewed in the last {days} days.</>;

  return (
    <div className={`settings-page ${styles.page} ${styles.enter}`}>
      <section className={styles.homeHero} aria-labelledby="overview-title">
        <div className={styles.homeHeroCopy}>
          <span className={styles.eyebrow}><i /> One workspace, one thread</span>
          <h1 id="overview-title">{greeting}, {firstNameOf(user?.displayName, user?.email)}.</h1>
          <p>Start from whatever needs to move — a meeting, the board, a task for an agent, a review — and the workspace keeps the thread between them.</p>
          <p className={styles.nutshell}>{nutshell}</p>
          <div className={styles.headerActions}>
            <Link href="/chat"><PremiumButton variant="primary">Start a new task</PremiumButton></Link>
            <Link href="/track"><PremiumButton variant="ghost">Open Track</PremiumButton></Link>
          </div>
        </div>
        <ProductOrbit compact />
      </section>

      {error && (
        <div className="settings-note settings-note--error" role="alert">
          {error} <button type="button" className="settings-action" onClick={() => void loadSummary()}>Try again</button>
        </div>
      )}

      <section className={styles.launchSection} aria-labelledby="launch-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span>Start from the outcome</span>
            <h2 id="launch-heading">What do you want to move forward?</h2>
          </div>
          <p>These are live product destinations, not sample dashboard cards.</p>
        </div>
        <div className={styles.actionGrid}>
          {OVERVIEW_ACTIONS.map((action, index) => (
            <Link key={action.href} href={action.href} className={styles.actionCard} data-tone={action.tone}>
              <span className={styles.actionMeta}>0{index + 1} · {action.meta}</span>
              <i aria-hidden />
              <h3>{action.title}</h3>
              <p>{action.copy}</p>
              <strong>Open <span aria-hidden>→</span></strong>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.loopRail} aria-label="BrainRouter operating loop">
        <span className={styles.loopLabel}>One workspace, one thread</span>
        <div>
          {PRODUCT_LOOP.map((step) => (
            <span key={step.label} data-tone={step.tone}><i />{step.label}<small>{step.detail}</small></span>
          ))}
        </div>
      </section>

      <section className={styles.telemetryHeading} aria-labelledby="telemetry-heading">
        <div>
          <span>Workspace telemetry</span>
          <h2 id="telemetry-heading">Review and security pulse</h2>
        </div>
        <div className={styles.telemetryControls}>
          <p>Charts are one operational signal—not the product itself.</p>
          <div className={styles.period} role="group" aria-label="Reporting period">
            {PERIODS.map((value) => (
              <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>
                Last {value} days
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.stats} aria-label={`Metrics for the last ${days} days`}>
        <MetricTile label="Security score" value={score} hint="out of 100" />
        <MetricTile
          label="Open issues"
          value={open}
          hint={metrics.issuesFound > 0 ? `${metrics.issuesFound} found · ${metrics.issuesFixed ?? 0} fixed` : "awaiting fix"}
        />
        <MetricTile label="Issues found" value={found} hint={`last ${days} days`} />
        <MetricTile label="Fix rate" value={`${fix}%`} hint="resolved" />
        <MetricTile
          label="PRs reviewed"
          value={prs}
          hint={verdicts.approved + verdicts.changesRequested > 0
            ? `${verdicts.approved} approved · ${verdicts.changesRequested} changes`
            : "pull requests"}
        />
        <MetricTile label="Pentests" value={pentests} hint="runs" />
      </section>

      {/* Row A — Issues over time (tabbed) + severity donut */}
      <section className={styles.charts} aria-label="Review analytics">
        <div className={`analytics-panel ${styles.chartWide}`}>
          <div className={styles.panelHead}>
            <h2>Issues over time</h2>
            <div className={styles.tabs} role="tablist" aria-label="Issue source">
              <button type="button" role="tab" aria-selected={issuesTab === "all"} onClick={() => setIssuesTab("all")}>All</button>
              <button type="button" role="tab" aria-selected={false} disabled title="Source breakdown isn't available yet">Pentests</button>
              <button type="button" role="tab" aria-selected={false} disabled title="Source breakdown isn't available yet">PR reviews</button>
            </div>
          </div>
          <div className={styles.panelBody}>
            {loading ? <InlineLoading label="Loading review history…" /> : <AreaChart data={summary.history} />}
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Open issues by severity</h2>
          <div className={styles.panelBody}>
            {loading ? <InlineLoading label="Loading severity mix…" /> : <Donut values={severity} />}
          </div>
        </div>
      </section>

      {/* Row B — PRs reviewed + addressed rate + top repositories */}
      <section className={styles.charts} aria-label="Review throughput">
        <div className="analytics-panel">
          <h2>PRs reviewed</h2>
          <div className={styles.panelBody}>
            {loading ? <InlineLoading label="Loading verdicts…" /> : <StackedBar values={verdicts} />}
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Findings addressed rate</h2>
          <div className={styles.panelBody}>
            {loading ? <InlineLoading label="Loading rate…" />
              : addressedRate.length >= 2
                ? <><LineChart points={addressedRate} /><p className={styles.chartNote}>Percent addressed per active repository</p></>
                : <div className={styles.empty}><strong>Not enough data yet</strong><span>Addressed rate appears once findings resolve across repositories.</span></div>}
          </div>
        </div>
        <div className="analytics-panel">
          <div className={styles.panelHead}>
            <h2>Top repositories</h2>
            <div className={styles.tabs} role="tablist" aria-label="Repository view">
              <button type="button" role="tab" aria-selected={repoTab === "repos"} onClick={() => setRepoTab("repos")}>Repos</button>
              <button type="button" role="tab" aria-selected={repoTab === "contributors"} onClick={() => setRepoTab("contributors")}>Contributors</button>
            </div>
          </div>
          <div className={styles.panelBody}>
            {loading ? <InlineLoading label="Loading repositories…" />
              : repoTab === "contributors"
                ? contributors.length === 0
                  ? <div className={styles.empty}><strong>No contributors yet</strong><span>Forge authors and commit contributors appear after a PR review.</span></div>
                  : (
                    <div className={styles.miniTable}>
                      {contributors.slice(0, 5).map((contributor) => (
                        <div key={contributor.login} className={styles.miniRow}>
                          <span className={styles.contributorIdentity}>
                            <i aria-hidden>{(contributor.displayName || contributor.login).slice(0, 1).toUpperCase()}</i>
                            <span><strong>{contributor.displayName || contributor.login}</strong><small>@{contributor.login}{contributor.lastActivityAt ? ` · ${relativeDay(contributor.lastActivityAt)}` : ""}</small></span>
                          </span>
                          <span className={styles.miniMeta}>{contributor.prs} PR{contributor.prs === 1 ? "" : "s"} · {contributor.commits} commit{contributor.commits === 1 ? "" : "s"}</span>
                          <span className={styles.miniMeta}>{contributor.findingsFixed} fixed · {contributor.openFindings} open</span>
                        </div>
                      ))}
                    </div>
                  )
                : repositories.length === 0
                  ? <div className={styles.empty}><strong>No repository activity</strong><span>Connect a repository to see review volume.</span></div>
                  : (
                    <div className={styles.miniTable}>
                      {repositories.slice(0, 5).map((repo) => (
                        <Link key={repo.repository} href={`/reviews?repo=${encodeURIComponent(repo.repository)}`} className={styles.miniRow}>
                          <span className={styles.miniName}>{repo.repository}</span>
                          <span className={styles.miniMeta}>{repo.prs} review{repo.prs === 1 ? "" : "s"}</span>
                          <span className={styles.miniMeta}>{repo.findings} found</span>
                        </Link>
                      ))}
                    </div>
                  )}
          </div>
        </div>
      </section>

      {/* Row C — Open vs fixed + MTTR + exploitability */}
      <section className={styles.charts} aria-label="Remediation posture">
        <div className="analytics-panel">
          <h2>Open vs fixed</h2>
          <div className={styles.panelBody}>
            {loading ? <InlineLoading label="Loading trend…" />
              : <><OpenFixedChart data={summary.history} /><p className={styles.chartNote}>Cumulative still-open vs fixed findings this period</p></>}
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Mean time to remediate</h2>
          <div className={styles.panelBody}>
            {metrics.meanTimeToRemediateDays == null
              ? <div className={styles.empty}><strong>No fixes in this period</strong><span>Shows the average time from first discovery to a verified absent finding.</span></div>
              : <div className={styles.remediationMetric}>
                  <strong>{metrics.meanTimeToRemediateDays < 1
                    ? `${Math.max(1, Math.round(metrics.meanTimeToRemediateDays * 24))}h`
                    : `${metrics.meanTimeToRemediateDays.toFixed(1)}d`}</strong>
                  <span>average from discovery to verified fix</span>
                </div>}
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Exploitability</h2>
          <div className={styles.panelBody}>
            <div className={styles.empty}>
              <strong>No known CVEs affecting you</strong>
              <span>Exploited-in-the-wild matches surface here.</span>
            </div>
          </div>
        </div>
      </section>

      {/* Row D — Top issues + affected assets + vuln types */}
      <section className={styles.charts} aria-label="Issue breakdown">
        <div className="analytics-panel">
          <div className={styles.panelHead}>
            <h2>Top issues</h2>
            <Link className={styles.headLink} href="/issues">View all <span aria-hidden>→</span></Link>
          </div>
          <div className={styles.panelBody}>
            {issuesLoading ? <InlineLoading label="Loading issues…" />
              : topIssues.length === 0
                ? <div className={styles.empty}><strong>No open issues</strong><span>Findings from reviews and pentests appear here.</span></div>
                : (
                  <ul className={styles.issueList}>
                    {topIssues.map((issue) => (
                      <li key={`${issue.reviewId}-${issue.finding.file}-${issue.finding.line ?? 0}`}>
                        <Link href="/issues" className={styles.issueRow}>
                          <span className={styles.issueTitle}>{issue.finding.title || issue.finding.file || "Untitled finding"}</span>
                          <SeverityBadge severity={issue.finding.severity} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Top affected assets</h2>
          <div className={styles.panelBody}>
            <div className={styles.empty}>
              <strong>No affected assets</strong>
              <span>Domains and repositories with open issues appear here.</span>
            </div>
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Issues by vulnerability type</h2>
          <div className={styles.panelBody}>
            {issuesLoading ? <InlineLoading label="Loading types…" />
              : vulnTypes.length === 0
                ? <div className={styles.empty}><strong>No categorized findings</strong><span>Open findings are grouped by CWE here.</span></div>
                : <TypeDonut buckets={vulnTypes} total={vulnTotal} />}
          </div>
        </div>
      </section>

      {/* Row E — unified verification activity + recent jobs */}
      <section className={styles.testing} aria-label="Workspace activity">
        <div className={`analytics-panel ${styles.activityPanel}`}>
          <div className={styles.panelHead}>
            <div>
              <span className={styles.activityEyebrow}>Verification timeline</span>
              <h2>Workspace activity</h2>
            </div>
            <span className={styles.headMuted}>{heatmap.total} event{heatmap.total === 1 ? "" : "s"} · last 12 months</span>
          </div>
          <div className={styles.activityLegend} aria-label="Activity totals by type">
            <span data-kind="review"><i /><strong>{heatmap.prReviews}</strong> PR reviews</span>
            <span data-kind="test"><i /><strong>{heatmap.tests}</strong> Security tests</span>
            <span data-kind="fixed"><i /><strong>{heatmap.fixed}</strong> Findings resolved</span>
          </div>
          <div className={styles.heatWrap}>
            {activityLoading ? <InlineLoading label="Loading workspace activity…" /> : <Heatmap weeks={heatmap.weeks} />}
          </div>
        </div>
        <div className={`analytics-panel ${styles.recentActivityPanel}`}>
          <div className={styles.panelHead}>
            <div>
              <span className={styles.activityEyebrow}>Latest signals</span>
              <h2>Recent verification</h2>
            </div>
            <Link className={styles.headLink} href="/reviews">Review console <span aria-hidden>→</span></Link>
          </div>
          <div className={styles.panelBody}>
            {activityLoading ? <InlineLoading label="Loading verification jobs…" />
              : recentActivity.length === 0
                ? <div className={styles.empty}><strong>No verification activity yet</strong><span>Run a PR review or an authorized security test to start the timeline.</span><div className={styles.emptyActions}><Link href="/reviews">Open reviews</Link><Link href="/pentests">Open pentests</Link></div></div>
                : (
                  <ul className={styles.testList}>
                    {recentActivity.map((job) => (
                      <li key={job.id}>
                        <Link href={activityHref(job)} className={styles.testRow}>
                          <span className={styles.testDot} data-kind={job.lens} data-state={job.status} aria-hidden />
                          <div className={styles.testMain}>
                            <strong>{activityTitle(job)}</strong>
                            <span>{activityTarget(job)}{job.findings != null ? ` · ${job.findings} finding${job.findings === 1 ? "" : "s"}` : ""}</span>
                          </div>
                          <span className={styles.testAgo}>{relativeDay(job.createdAt) || "—"}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
        </div>
      </section>

      {/* Row F — What's new in cyber (feed + detections + globe) + repositories */}
      <section className={styles.lower}>
        <article className={styles.cyber} aria-label="What's new in cyber">
          <div className={styles.cyberHead}>
            <div>
              <h2>What&apos;s new in cyber</h2>
              {cveTotal > 0 && <p className={styles.cyberCount}>{cveTotal.toLocaleString()} CVEs tracked</p>}
            </div>
            <Link href="/vulnerabilities">CVE tracker <span aria-hidden>→</span></Link>
          </div>

          <div className={styles.detections}>
            <div className={styles.detectionNums}>
              <div>
                <strong>{cve7d == null ? "—" : cve7d.toLocaleString()}</strong>
                <span>New in last 7 days</span>
              </div>
              <div>
                <strong>{cve30d == null ? "—" : cve30d.toLocaleString()}</strong>
                <span>New in last 30 days</span>
              </div>
            </div>
            <EarthGlobe size={148} className={styles.globe} />
          </div>

          {cveLoading ? <div className={styles.feedEmpty}><InlineLoading label="Loading latest CVEs…" /></div>
            : cveItems.length === 0 ? <div className={styles.feedEmpty}>No vulnerability detections available yet.</div>
              : (
                <div className={styles.cyberList}>
                  {cveItems.map((item) => (
                    <Link key={item.cveId} href={`/vulnerabilities?cve=${encodeURIComponent(item.cveId)}`} className={styles.cyberRow}>
                      <div className={styles.cyberMain}>
                        <div className={styles.cyberId}>
                          <strong>{item.cveId}</strong>
                          <SeverityBadge severity={item.severity ?? "unrated"} />
                        </div>
                        <span className={styles.cyberSummary}>{item.summary || "No description available"}</span>
                      </div>
                      <div className={styles.cyberMeta}>
                        <span className={styles.cyberCvss}>{item.cvssScore != null ? `CVSS ${item.cvssScore.toFixed(1)}` : "CVSS —"}</span>
                        <span className={styles.cyberAgo}>{relativeDay(item.publishedAt) || "—"}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
        </article>

        <section className="overview-repositories" aria-label="Most active repositories">
          <header>
            <div><span>Repositories</span><h2>Most active workspaces</h2></div>
            <Link href="/projects">All projects <span aria-hidden>→</span></Link>
          </header>
          {loading ? <InlineLoading label="Loading repositories…" />
            : repositories.length === 0 ? (
              <div className="overview-repository-empty"><span>No repository activity yet.</span><Link href="/integrations">Connect a repository</Link></div>
            ) : (
              <div className="overview-repository-list">
                {repositories.slice(0, 5).map((repository) => (
                  <div key={repository.repository}>
                    <strong>{repository.repository}</strong>
                    <span>{repository.prs} review{repository.prs === 1 ? "" : "s"}</span>
                    <span>{repository.findings} found</span>
                    <span>{repository.addressed} resolved</span>
                    <Link href={`/reviews?repo=${encodeURIComponent(repository.repository)}`} aria-label={`Open reviews for ${repository.repository}`}>→</Link>
                  </div>
                ))}
              </div>
            )}
        </section>
      </section>
    </div>
  );
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
function severityWeight(severity: string): number {
  return SEVERITY_WEIGHT[severity.toLowerCase()] ?? 0;
}

interface HeatDay {
  key: string; count: number; prReviews: number; tests: number; fixed: number;
  level: 0 | 1 | 2 | 3 | 4; date: string;
}
interface HeatData { weeks: HeatDay[][]; total: number; prReviews: number; tests: number; fixed: number }

function activityTitle(job: ReviewJob): string {
  if (job.lens === "pentest") return "Security test";
  if (job.lens === "code") return "Code review";
  return "Security review";
}

function activityTarget(job: ReviewJob): string {
  if (job.repo && job.prNumber != null) return `${job.repo} · PR #${job.prNumber}`;
  return job.repo || "Authorized target";
}

function activityHref(job: ReviewJob): string {
  // CWE-88: prNumber arrives from the API as `number | null` but is still
  // encoded like every other query argument so a malformed value can never
  // smuggle extra parameters into the link.
  if (job.repo && job.prNumber != null) return `/reviews/pr?repo=${encodeURIComponent(job.repo)}&number=${encodeURIComponent(String(job.prNumber))}`;
  return job.lens === "pentest" ? "/pentests" : "/reviews";
}

/** Build a 53-week × 7-day grid from the backend's unique verification jobs. */
function buildHeatmap(history: ReviewSummary["history"]): HeatData {
  const byDay = new Map(history.map((day) => [day.date, day]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  // Walk back to the Sunday on/after 52 weeks ago so columns are aligned weeks.
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7 * 52 - end.getUTCDay());
  const weeks: HeatDay[][] = [];
  let cursor = new Date(start);
  let total = 0;
  let prReviews = 0;
  let tests = 0;
  let fixed = 0;
  while (cursor <= end) {
    const week: HeatDay[] = [];
    for (let d = 0; d < 7 && cursor <= end; d += 1) {
      const key = cursor.toISOString().slice(0, 10);
      const source = byDay.get(key);
      const count = source?.activity ?? 0;
      const dayPrReviews = source?.prReviews ?? 0;
      const dayTests = source?.tests ?? 0;
      const dayFixed = source?.fixed ?? 0;
      total += count;
      prReviews += dayPrReviews;
      tests += dayTests;
      fixed += dayFixed;
      const level: HeatDay["level"] = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
      week.push({
        key, count, prReviews: dayPrReviews, tests: dayTests, fixed: dayFixed, level,
        date: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
      });
      cursor = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return { weeks, total, prReviews, tests, fixed };
}

function Heatmap({ weeks }: { weeks: HeatDay[][] }) {
  return (
    <div className={styles.heat} role="img" aria-label="PR review, security test, and remediation activity over the last year">
      {weeks.map((week, wi) => (
        <div key={week[0]?.key ?? wi} className={styles.heatCol}>
          {week.map((day) => (
            <span
              key={day.key}
              className={styles.heatCell}
              data-level={day.level}
              aria-hidden="true"
              title={`${day.count} verification event${day.count === 1 ? "" : "s"} · ${day.prReviews} PR review${day.prReviews === 1 ? "" : "s"} · ${day.tests} security test${day.tests === 1 ? "" : "s"} · ${day.fixed} resolved · ${day.date}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Monochrome donut for vulnerability-type buckets (distinct grey steps). */
function TypeDonut({ buckets, total }: { buckets: [string, number][]; total: number }) {
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 42 42" role="img" aria-label={`${total} findings by type`}>
        <circle className="donut__track" cx="21" cy="21" r="15.9155" fill="none" strokeWidth="4" />
        {buckets.map(([key, value], index) => {
          const dash = total ? (value / total) * 100 : 0;
          const segment = (
            <circle
              key={key}
              cx="21" cy="21" r="15.9155" fill="none"
              stroke={TYPE_RAMP[index % TYPE_RAMP.length]} strokeWidth="4"
              strokeDasharray={`${dash} ${100 - dash}`} strokeDashoffset={-offset}
              transform="rotate(-90 21 21)"
            />
          );
          offset += dash;
          return segment;
        })}
      </svg>
      <div className="donut__center"><strong>{total}</strong><span>Findings</span></div>
      <div className="donut__legend">
        {buckets.map(([key, value], index) => (
          <span key={key} className="chart__legend-item">
            <i style={{ background: TYPE_RAMP[index % TYPE_RAMP.length] }} />{key} {value}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function OverviewPage() {
  return <AuthGuard><Overview /></AuthGuard>;
}
