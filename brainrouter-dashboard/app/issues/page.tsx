"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentTraceGraph } from "../../components/AgentTraceGraph";
import { AuthGuard } from "../../components/AuthGuard";
import { DataTable, SeverityBadge, StatusBadge } from "../../components/Analytics";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type OrgSummary, type ReviewIssue, type ReviewIssuesResponse, type ReviewJob } from "../../lib/adminApi";

const TABS = ["all", "open", "in progress", "snoozed", "fixed", "ignored"] as const;
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Tab = typeof TABS[number];

function validValue<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return value && values.includes(value as T) ? value as T : fallback;
}

function Issues() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // Active org comes from the validated orgs list (an explicit selector), NOT an
  // untrusted `?org=` URL param — the server also enforces membership per request
  // (resolveOrgContext → 403 for non-members), so this is scoping, not a gate.
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState<string>("");
  const [tab, setTab] = useState<Tab>(() => validValue(searchParams.get("status"), TABS, "all"));
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [severity, setSeverity] = useState(() => validValue(searchParams.get("severity"), ["all", ...SEVERITIES] as const, "all"));
  const [repo, setRepo] = useState(() => searchParams.get("repository") ?? "all");
  const [sort, setSort] = useState<"newest" | "oldest">(() => searchParams.get("sort") === "oldest" ? "oldest" : "newest");
  const [cursor, setCursor] = useState<string | null>(() => searchParams.get("cursor"));
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [response, setResponse] = useState<ReviewIssuesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedReview, setSelectedReview] = useState<ReviewJob | null>(null);
  const [traceReviewId, setTraceReviewId] = useState<string | null>(() => searchParams.get("review"));
  const [traceLoading, setTraceLoading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await adminApi.listOrgs();
        setOrgs(res.orgs ?? []);
        const def = (res.orgs ?? []).find((o) => o.isDefault) ?? (res.orgs ?? [])[0];
        if (def) setActiveOrg(def.orgId);
      } catch { /* fall back to the server's default org */ }
    })();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (severity !== "all") params.set("severity", severity);
    if (repo !== "all") params.set("repository", repo);
    if (tab !== "all") params.set("status", tab);
    if (sort !== "newest") params.set("sort", sort);
    if (cursor) params.set("cursor", cursor);
    if (traceReviewId) params.set("review", traceReviewId);
    router.replace(params.size ? `/issues?${params}` : "/issues", { scroll: false });
  }, [router, debouncedQuery, severity, repo, tab, sort, cursor, traceReviewId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    adminApi.listReviewIssues({
      limit: 50,
      q: debouncedQuery,
      severity,
      repo,
      status: tab,
      sort,
      ...(cursor ? { cursor } : {}),
    }, activeOrg || undefined, controller.signal).then((result) => {
      setResponse(result);
      setError("");
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Failed to load issues");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [activeOrg, debouncedQuery, severity, repo, tab, sort, cursor]);

  useEffect(() => {
    if (!traceReviewId || selectedReview?.id === traceReviewId) return;
    setTraceLoading(true);
    adminApi.getReviewJob(traceReviewId, activeOrg || undefined).then((result) => { setSelectedReview(result.review); setError(""); }).catch((caught) => { setSelectedReview(null); setError(caught instanceof Error ? caught.message : "Failed to load agent trace"); }).finally(() => setTraceLoading(false));
  }, [traceReviewId, selectedReview?.id, activeOrg]);

  const resetPage = useCallback(() => { setCursor(null); setCursorHistory([]); }, []);
  const repositories = useMemo(() => [...new Set((response?.issues ?? []).map((issue) => issue.repo).filter((value): value is string => Boolean(value)))].sort(), [response]);
  const openTrace = (issue: ReviewIssue) => {
    setSelectedReview(null);
    setTraceReviewId(issue.reviewId);
    setError("");
  };
  const goNext = () => {
    if (!response?.nextCursor) return;
    setCursorHistory((current) => [...current, cursor]);
    setCursor(response.nextCursor);
  };
  const goBack = () => {
    setCursorHistory((current) => {
      if (!current.length) return current;
      setCursor(current[current.length - 1] ?? null);
      return current.slice(0, -1);
    });
  };

  const issues = response?.issues ?? [];
  const severityCounts = response?.severity ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  return (
    <div className="settings-page">
      <PageHeader title="Issues" description="Verified findings from reviews and connected analysis workflows." />
      <div className="analytics-grid kpi-row">
        {SEVERITIES.slice(0, 4).map((value) => <div className="metric-tile" key={value}><SeverityBadge severity={value} /><strong>{severityCounts[value]}</strong><span>matching findings</span></div>)}
      </div>
      <section className="analytics-panel issues-panel">
        <div className="issue-tabs" role="tablist">{TABS.map((value) => <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? "issue-tab issue-tab--active" : "issue-tab"} onClick={() => { setTab(value); resetPage(); }} key={value}>{value}</button>)}</div>
        <div className="issue-filters">
          <input className="settings-input" aria-label="Search findings" placeholder="Search issues" value={query} onChange={(event) => { setQuery(event.target.value); resetPage(); }} />
          <select className="settings-select" aria-label="Severity filter" value={severity} onChange={(event) => { setSeverity(validValue(event.target.value, ["all", ...SEVERITIES] as const, "all")); resetPage(); }}><option value="all">All severities</option>{SEVERITIES.map((value) => <option value={value} key={value}>{value}</option>)}</select>
          {orgs.length > 1 && <select className="settings-select" aria-label="Organization" value={activeOrg} onChange={(event) => { setActiveOrg(event.target.value); resetPage(); }}>{orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}</select>}
          <select className="settings-select" aria-label="Repository filter" value={repo} onChange={(event) => { setRepo(event.target.value); resetPage(); }}><option value="all">All repositories</option>{repo !== "all" && !repositories.includes(repo) && <option value={repo}>{repo}</option>}{repositories.map((value) => <option value={value} key={value}>{value}</option>)}</select>
          <select className="settings-select" aria-label="Sort issues" value={sort} onChange={(event) => { setSort(event.target.value === "oldest" ? "oldest" : "newest"); resetPage(); }}><option value="newest">Newest</option><option value="oldest">Oldest</option></select>
        </div>
        {error && <div className="settings-note settings-note--error" role="alert">{error}</div>}
        {loading && !response ? <div className="settings-empty-inline">Loading matching issues…</div> : issues.length ? (
          <>
            <DataTable headers={["Severity", "Finding", "Repository", "Status", "Provenance"]}>{issues.map((issue) => (
              <tr key={`${issue.reviewId}:${issue.finding.file}:${issue.finding.line ?? 0}:${issue.createdAt}`}>
                <td><SeverityBadge severity={issue.finding.severity} /></td>
                <td><strong>{issue.finding.title ?? issue.finding.summary ?? "Finding"}</strong><div className="settings-row__sub">{issue.finding.file}{issue.finding.line ? `:${issue.finding.line}` : ""}</div></td>
                <td>{issue.repo ?? "—"}</td>
                <td><StatusBadge tone={issue.issueStatus === "fixed" ? "ok" : issue.issueStatus === "open" ? "danger" : "warn"}>{issue.issueStatus}</StatusBadge></td>
                <td><div className="issues-provenance">{issue.repo && issue.prNumber ? <Link className="settings-link" href={`/reviews/pr?repo=${encodeURIComponent(issue.repo)}&number=${issue.prNumber}${activeOrg ? `&org=${encodeURIComponent(activeOrg)}` : ""}`}>PR #{issue.prNumber}</Link> : <span>Review</span>}<button type="button" className="settings-link settings-link--button" onClick={() => openTrace(issue)}>Agent Trace</button></div></td>
              </tr>
            ))}</DataTable>
            <div className="issues-pagination"><span>{response?.total ?? issues.length} matching issues · page shows {issues.length}</span><div><PremiumButton size="small" disabled={!cursorHistory.length} onClick={goBack}>Previous</PremiumButton><PremiumButton size="small" disabled={!response?.nextCursor} onClick={goNext}>Next</PremiumButton></div></div>
          </>
        ) : <EmptyState title="No matching issues" description="Run a review or adjust the filters to see verified findings." />}
      </section>
      {(traceLoading || selectedReview) && <section className="issues-trace" aria-label="Originating review trace">{traceLoading && !selectedReview ? <div className="settings-empty-inline">Loading Agent Trace…</div> : selectedReview && <><div className="issues-trace__head"><div><span>Originating review</span><h2>{selectedReview.repo} #{selectedReview.prNumber}</h2></div><button type="button" className="settings-link settings-link--button" onClick={() => { setTraceReviewId(null); setSelectedReview(null); }}>Close</button></div><AgentTraceGraph reviews={[selectedReview]} /></>}</section>}
    </div>
  );
}

export default function IssuesPage() {
  return <AuthGuard><Issues /></AuthGuard>;
}
