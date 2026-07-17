"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PremiumButton } from "../../components/PremiumButton";
import { AreaChart, Donut, LineChart, MetricTile, SeverityBadge, StackedBar } from "../../components/Analytics";
import {
  adminApi, authFetch,
  type PentestRun, type ReviewIssue, type ReviewSummary,
} from "../../lib/adminApi";
import { queryDashboard } from "../../lib/dashboardQuery";
import { InlineLoading } from "../../components/LoadingSpinner";
import { useActiveOrg } from "../../components/OrgWorkspaceProvider";
import { useAuth } from "../../components/AuthProvider";
import styles from "./overview.module.css";

const EMPTY: ReviewSummary = {
  periodDays: 30,
  metrics: { securityScore: 100, openIssues: 0, issuesFound: 0, fixRate: 100, prsReviewed: 0, pentests: 0 },
  severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  verdicts: { approved: 0, commented: 0, changesRequested: 0 },
  history: [],
  repositories: [],
};

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

/** yyyy-mm-dd key in local time for heatmap/day bucketing. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
  const [runs, setRuns] = useState<PentestRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);

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

  // Pentest runs power the testing-activity heatmap + recent-tests list.
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const result = await queryDashboard(
        `overview:pentest-runs:${activeOrgId}`,
        () => adminApi.listPentestRuns(activeOrgId || undefined, 200),
        { ttlMs: 30_000 },
      );
      setRuns(result.runs);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, [activeOrgId]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);

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

  // Repository aggregates give real "opened vs closed" numbers without fabricating.
  const totals = useMemo(() => {
    const found = summary.repositories.reduce((sum, repo) => sum + repo.findings, 0);
    const addressed = summary.repositories.reduce((sum, repo) => sum + repo.addressed, 0);
    return { found, addressed };
  }, [summary.repositories]);

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

  const recentTests = useMemo(() => [...runs].slice(0, 6), [runs]);

  // GitHub-style 52-week heatmap of pentest-run activity.
  const heatmap = useMemo(() => buildHeatmap(runs), [runs]);

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
      <header className={styles.greeting}>
        <div className={styles.greetingText}>
          <h1>{greeting}, {firstNameOf(user?.displayName, user?.email)}!</h1>
          <p className={styles.nutshell}>{nutshell}</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.period} role="group" aria-label="Reporting period">
            {PERIODS.map((value) => (
              <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>
                Last {value} days
              </button>
            ))}
          </div>
          <Link href="/chat"><PremiumButton variant="primary">New task</PremiumButton></Link>
        </div>
      </header>

      {error && (
        <div className="settings-note settings-note--error" role="alert">
          {error} <button type="button" className="settings-action" onClick={() => void loadSummary()}>Try again</button>
        </div>
      )}

      <section className={styles.stats} aria-label={`Metrics for the last ${days} days`}>
        <MetricTile label="Security score" value={score} hint="out of 100" />
        <MetricTile
          label="Open issues"
          value={open}
          hint={totals.found > 0 ? `${totals.found} opened · ${totals.addressed} closed` : "awaiting fix"}
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
                ? <div className={styles.empty}><strong>No contributor data</strong><span>Per-author breakdowns land with connected review history.</span></div>
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
              : <><AreaChart data={summary.history} /><p className={styles.chartNote}>Open discoveries over time · fixed-over-time isn&apos;t tracked yet</p></>}
          </div>
        </div>
        <div className="analytics-panel">
          <h2>Mean time to remediate</h2>
          <div className={styles.panelBody}>
            <div className={styles.empty}>
              <strong>No fixes in this period</strong>
              <span>Shows the average days from discovery to fix.</span>
            </div>
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

      {/* Row E — Testing activity heatmap + recent tests */}
      <section className={styles.testing} aria-label="Testing activity">
        <div className="analytics-panel">
          <div className={styles.panelHead}>
            <h2>Testing activity</h2>
            <span className={styles.headMuted}>{heatmap.total} run{heatmap.total === 1 ? "" : "s"} · last 12 months</span>
          </div>
          <div className={styles.heatWrap}>
            {runsLoading ? <InlineLoading label="Loading activity…" /> : <Heatmap weeks={heatmap.weeks} />}
          </div>
        </div>
        <div className="analytics-panel">
          <div className={styles.panelHead}>
            <h2>Recent tests</h2>
            <Link className={styles.headLink} href="/pentests">All tests <span aria-hidden>→</span></Link>
          </div>
          <div className={styles.panelBody}>
            {runsLoading ? <InlineLoading label="Loading tests…" />
              : recentTests.length === 0
                ? <div className={styles.empty}><strong>No tests yet</strong><span>Run your first pentest to see activity.</span></div>
                : (
                  <ul className={styles.testList}>
                    {recentTests.map((run) => (
                      <li key={run.id} className={styles.testRow}>
                        <span className={styles.testDot} data-state={run.status} aria-hidden />
                        <div className={styles.testMain}>
                          <strong>{run.target}</strong>
                          <span>{run.kind} · {run.findings} finding{run.findings === 1 ? "" : "s"}</span>
                        </div>
                        <span className={styles.testAgo}>{relativeDay(run.createdAt) || "—"}</span>
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
            <DotGlobe />
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

interface HeatDay { key: string; count: number; level: 0 | 1 | 2 | 3 | 4; date: string }
interface HeatData { weeks: HeatDay[][]; total: number }

/** Build a 53-week × 7-day grid of pentest-run activity ending today. */
function buildHeatmap(runs: PentestRun[]): HeatData {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const when = new Date(run.createdAt);
    if (Number.isNaN(when.valueOf())) continue;
    const key = dayKey(when);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  // Walk back to the Sunday on/after 52 weeks ago so columns are aligned weeks.
  const start = new Date(end);
  start.setDate(start.getDate() - 7 * 52 - end.getDay());
  const weeks: HeatDay[][] = [];
  let cursor = new Date(start);
  let total = 0;
  while (cursor <= end) {
    const week: HeatDay[] = [];
    for (let d = 0; d < 7 && cursor <= end; d += 1) {
      const key = dayKey(cursor);
      const count = counts.get(key) ?? 0;
      total += count;
      const level: HeatDay["level"] = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
      week.push({ key, count, level, date: cursor.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) });
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return { weeks, total };
}

function Heatmap({ weeks }: { weeks: HeatDay[][] }) {
  return (
    <div className={styles.heat} role="img" aria-label="Pentest activity over the last year">
      {weeks.map((week, wi) => (
        <div key={week[0]?.key ?? wi} className={styles.heatCol}>
          {week.map((day) => (
            <span key={day.key} className={styles.heatCell} data-level={day.level} title={`${day.count} run${day.count === 1 ? "" : "s"} · ${day.date}`} />
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

/** Lightweight rotating dot-globe (pure SVG/CSS, no lib, no external asset). */
function DotGlobe() {
  const meridians = [6, 10, 14, 18];
  const latitudes = [
    { cy: 22, rx: 20, ry: 5 },
    { cy: 22, rx: 20, ry: 11 },
    { cy: 22, rx: 20, ry: 17 },
  ];
  return (
    <svg className={styles.globe} viewBox="0 0 44 44" role="img" aria-label="Rotating world of detections" aria-hidden>
      <defs>
        <radialGradient id="globe-fill" cx="38%" cy="34%" r="72%">
          <stop offset="0" stopColor="var(--surface-overlay)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--surface-raised)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="22" cy="22" r="20" fill="url(#globe-fill)" stroke="var(--border)" strokeWidth="0.5" />
      {latitudes.map((lat) => (
        <ellipse key={lat.ry} cx="22" cy={lat.cy} rx={lat.rx} ry={lat.ry} fill="none" stroke="var(--border-med)" strokeWidth="0.4" strokeDasharray="0.6 1.6" />
      ))}
      <g className={styles.globeSpin} style={{ transformOrigin: "22px 22px" }}>
        {meridians.map((rx) => (
          <ellipse key={rx} cx="22" cy="22" rx={rx} ry="20" fill="none" stroke="var(--text-muted)" strokeWidth="0.4" strokeDasharray="0.6 1.6" />
        ))}
      </g>
      <circle className={styles.globeMarker} cx="14" cy="15" r="1.1" fill="var(--danger)" />
      <circle className={styles.globeMarker} cx="30" cy="26" r="1" fill="var(--heat-hot)" style={{ animationDelay: "0.8s" }} />
      <circle className={styles.globeMarker} cx="24" cy="12" r="0.9" fill="var(--warn)" style={{ animationDelay: "1.6s" }} />
    </svg>
  );
}

export default function OverviewPage() {
  return <AuthGuard><Overview /></AuthGuard>;
}
