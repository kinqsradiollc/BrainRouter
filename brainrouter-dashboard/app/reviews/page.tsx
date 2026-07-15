"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { StatusBadge } from "../../components/Analytics";
import { adminApi, type OrgSummary, type ReviewJob, type ReviewPullRequest } from "../../lib/adminApi";
import { invalidateDashboardQueries, queryDashboard } from "../../lib/dashboardQuery";
import { InlineLoading } from "../../components/LoadingSpinner";
import {
  REVIEW_ACTION_LABELS,
  filterReviewPullRequests,
  reviewActionPresentation,
  reviewStatus,
  reviewsReturnPath,
  type ReviewDraftFilter,
  type ReviewAutomationFilter,
  type ReviewListFilters,
  type ReviewSort,
  type ReviewStatusFilter,
} from "./reviewPresentation";

const STATUS_FILTERS = new Set<ReviewStatusFilter>(["all", "attention", "running", "complete", "not-reviewed"]);
const AUTOMATION_FILTERS = new Set<ReviewAutomationFilter>(["all", "automatic", "on-demand"]);
const DRAFT_FILTERS = new Set<ReviewDraftFilter>(["all", "ready", "draft"]);
const SORTS = new Set<ReviewSort>(["updated-desc", "updated-asc", "created-desc", "created-asc", "comments-desc"]);

function initialParam(name: string): string {
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get(name) ?? "";
}

function initialStatus(): ReviewStatusFilter {
  const value = initialParam("status") as ReviewStatusFilter;
  return STATUS_FILTERS.has(value) ? value : "all";
}

function initialAutomation(): ReviewAutomationFilter {
  const value = initialParam("automation") as ReviewAutomationFilter;
  return AUTOMATION_FILTERS.has(value) ? value : "all";
}

function initialDraft(): ReviewDraftFilter {
  const value = initialParam("draft") as ReviewDraftFilter;
  return DRAFT_FILTERS.has(value) ? value : "all";
}

function initialSort(): ReviewSort {
  const value = initialParam("sort") as ReviewSort;
  return SORTS.has(value) ? value : "updated-desc";
}

function lensLabel(job: ReviewJob | null): string {
  if (!job) return "Not run";
  if (job.error) return "Failed";
  const status = job.status.toLowerCase();
  if (status === "pending" || status === "queued") return "Queued";
  if (status === "running") return "Running";
  if ((job.blocking ?? 0) > 0) return `${job.blocking} blocking`;
  if (job.findings !== null) return `${job.findings} finding${job.findings === 1 ? "" : "s"}`;
  return status || "Not run";
}

function updatedLabel(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function ReviewsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [prs, setPrs] = useState<ReviewPullRequest[]>([]);
  const [canRun, setCanRun] = useState(false);
  const [partial, setPartial] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState(() => initialParam("q"));
  const [repository, setRepository] = useState(() => initialParam("repository") || "all");
  const [author, setAuthor] = useState(() => initialParam("author") || "all");
  const [label, setLabel] = useState(() => initialParam("label") || "all");
  const [draft, setDraft] = useState<ReviewDraftFilter>(initialDraft);
  const [status, setStatus] = useState<ReviewStatusFilter>(initialStatus);
  const [automation, setAutomation] = useState<ReviewAutomationFilter>(initialAutomation);
  const [sort, setSort] = useState<ReviewSort>(initialSort);

  useEffect(() => {
    void (async () => {
      try {
        const response = await queryDashboard("orgs", () => adminApi.listOrgs(), { ttlMs: 60_000 });
        const available = response.orgs ?? [];
        setOrgs(available);
        const requested = initialParam("org");
        const selected = available.find((org) => org.orgId === requested)
          ?? available.find((org) => org.isDefault)
          ?? available[0];
        if (selected) setActiveOrg(selected.orgId);
        else setLoading(false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to load organizations");
        setLoading(false);
      }
    })();
  }, []);

  const load = useCallback(async (orgId: string, force = false) => {
    if (!orgId) return;
    setLoading(true);
    setError("");
    try {
      const response = await queryDashboard(`review-prs:${orgId}`, () => adminApi.listReviewPrs(orgId, force), { ttlMs: 30_000, force });
      setPrs(response.prs ?? []);
      setCanRun(Boolean(response.canRun));
      setPartial(Boolean(response.partial));
      setRefreshing(Boolean(response.cache?.refreshing));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load pull requests");
      setPrs([]);
      setCanRun(false);
      setPartial(false);
      setRefreshing(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(activeOrg); }, [activeOrg, load]);

  const filters: ReviewListFilters = useMemo(() => ({ query, repository, author, label, draft, status, automation, sort }), [query, repository, author, label, draft, status, automation, sort]);
  const returnPath = useMemo(() => reviewsReturnPath(filters, activeOrg), [filters, activeOrg]);
  const repositories = useMemo(() => [...new Set(prs.map((pr) => pr.repo))].sort((a, b) => a.localeCompare(b)), [prs]);
  const authors = useMemo(() => [...new Set(prs.map((pr) => pr.author).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)), [prs]);
  const labels = useMemo(() => [...new Set(prs.flatMap((pr) => pr.labels))].sort((a, b) => a.localeCompare(b)), [prs]);
  const displayed = useMemo(() => filterReviewPullRequests(prs, filters), [prs, filters]);

  useEffect(() => {
    if (typeof window !== "undefined" && activeOrg && window.location.pathname === "/reviews") {
      window.history.replaceState(window.history.state, "", returnPath);
    }
  }, [activeOrg, returnPath]);

  const run = async (pr: ReviewPullRequest, lens: "security" | "code" | "both") => {
    const key = `${pr.repo}#${pr.number}`;
    setBusy(key);
    setError("");
    try {
      await adminApi.runReview({ repo: pr.repo, prNumber: pr.number, lens }, activeOrg);
      invalidateDashboardQueries(`review-prs:${activeOrg}`);
      await load(activeOrg);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to queue review");
    } finally {
      setBusy("");
    }
  };

  const clearFilters = () => {
    setQuery("");
    setRepository("all");
    setAuthor("all");
    setLabel("all");
    setDraft("all");
    setStatus("all");
    setAutomation("all");
    setSort("updated-desc");
  };

  return (
    <div className="settings-page review-console">
      <PageHeader title="PR reviews" description="Open pull requests you can access, their latest review state, and the actions available to your role.">
        <Link className="premium-button premium-button--ghost premium-button--medium" href={`/review-automation${activeOrg ? `?org=${encodeURIComponent(activeOrg)}` : ""}`}>Review automation</Link>
      </PageHeader>

      {orgs.length > 1 && (
        <label className="settings-label review-console__org">Team
          <select className="settings-select" value={activeOrg} onChange={(event) => setActiveOrg(event.target.value)}>
            {orgs.map((org) => <option key={org.orgId} value={org.orgId}>{org.name}</option>)}
          </select>
        </label>
      )}

      {error && <div className="settings-note settings-note--error" role="alert">{error}</div>}

      <section className="review-console__filters" aria-label="Pull request filters">
        <label className="settings-label review-console__search">Search
          <input className="settings-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, repository, author, or PR number" />
        </label>
        <label className="settings-label">Repository
          <select className="settings-select" value={repository} onChange={(event) => setRepository(event.target.value)}>
            <option value="all">All repositories</option>
            {repositories.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
          </select>
        </label>
        <label className="settings-label">Author
          <select className="settings-select" value={author} onChange={(event) => setAuthor(event.target.value)}>
            <option value="all">Anyone</option>
            {authors.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="settings-label">Label
          <select className="settings-select" value={label} onChange={(event) => setLabel(event.target.value)}>
            <option value="all">All labels</option>
            {labels.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="settings-label">Pull request
          <select className="settings-select" value={draft} onChange={(event) => setDraft(event.target.value as ReviewDraftFilter)}>
            <option value="all">Ready and draft</option><option value="ready">Ready for review</option><option value="draft">Draft</option>
          </select>
        </label>
        <label className="settings-label">Review state
          <select className="settings-select" value={status} onChange={(event) => setStatus(event.target.value as ReviewStatusFilter)}>
            <option value="all">All states</option>
            <option value="attention">Needs attention</option>
            <option value="running">Running</option>
            <option value="complete">Both complete</option>
            <option value="not-reviewed">Not reviewed</option>
          </select>
        </label>
        <label className="settings-label">Automation
          <select className="settings-select" value={automation} onChange={(event) => setAutomation(event.target.value as ReviewAutomationFilter)}>
            <option value="all">Automatic and on demand</option>
            <option value="automatic">Automatic</option>
            <option value="on-demand">On demand</option>
          </select>
        </label>
        <label className="settings-label">Sort
          <select className="settings-select" value={sort} onChange={(event) => setSort(event.target.value as ReviewSort)}>
            <option value="updated-desc">Recently updated</option><option value="updated-asc">Least recently updated</option>
            <option value="created-desc">Newest</option><option value="created-asc">Oldest</option><option value="comments-desc">Most commented</option>
          </select>
        </label>
      </section>

      <div className="review-console__summary">
        <span>{loading ? "Loading pull requests…" : `${displayed.length} of ${prs.length} open pull request${prs.length === 1 ? "" : "s"}${refreshing ? " · refreshing" : ""}`}</span>
        <span className="review-console__summary-actions">
          {(query || repository !== "all" || author !== "all" || label !== "all" || draft !== "all" || status !== "all" || automation !== "all" || sort !== "updated-desc") && <button type="button" onClick={clearFilters}>Clear filters</button>}
          <button type="button" onClick={() => void load(activeOrg, true)} disabled={loading}>Refresh</button>
        </span>
      </div>
      {partial && <div className="settings-note settings-note--warning" role="status">Some repositories did not refresh in time. Showing all available cached results.</div>}

      {!loading && displayed.length === 0 ? (
        <EmptyState
          title={prs.length ? "No pull requests match these filters" : "No open pull requests"}
          description={prs.length ? "Clear or adjust the filters to return to the operational list." : "Connect GitHub and grant repository access. Automatic enrollment is optional for manual reviews."}
        >
          {prs.length ? <PremiumButton size="small" onClick={clearFilters}>Clear filters</PremiumButton> : <Link className="settings-link" href="/integrations">Open connections</Link>}
        </EmptyState>
      ) : (
        <div className="review-console__table-shell" aria-busy={loading}>
          <table className="review-console__table">
            <thead><tr><th>Pull request</th><th>Repository</th><th>Review state</th><th>Updated</th><th>Actions</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="review-console__loading"><InlineLoading label="Loading open pull requests…" /></td></tr>
              ) : displayed.map((pr) => {
                const key = `${pr.repo}#${pr.number}`;
                const presentation = reviewStatus(pr);
                const action = reviewActionPresentation(canRun, pr.availability, busy === key);
                const detailQuery = new URLSearchParams({ repo: pr.repo, number: String(pr.number), from: returnPath });
                if (activeOrg) detailQuery.set("org", activeOrg);
                return (
                  <tr key={key}>
                    <td>
                      <Link className="review-console__title" href={`/reviews/pr?${detailQuery.toString()}`}>{pr.title}</Link>
                      <div className="review-console__meta">#{pr.number} · {pr.author ?? "Unknown author"}{pr.draft ? " · Draft" : ""} · {pr.comments} comments</div>
                      {pr.labels.length > 0 && <div className="review-console__labels">{pr.labels.slice(0, 4).map((value) => <span key={value}>{value}</span>)}</div>}
                    </td>
                    <td>
                      <span className="review-console__repo" title={pr.repo}>{pr.repo}</span>
                      <div><StatusBadge tone={pr.availability.autoReviewEnabled ? "ok" : "neutral"}>{pr.availability.autoReviewEnabled ? "Automatic" : "On demand"}</StatusBadge></div>
                    </td>
                    <td>
                      <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
                      <div className="review-console__lens-state"><span>Security: {lensLabel(pr.security)}</span><span>Code: {lensLabel(pr.code)}</span></div>
                    </td>
                    <td className="review-console__date">{updatedLabel(pr.updatedAt)}</td>
                    <td>
                      <div className="review-console__actions">
                        <PremiumButton size="small" title={action.help} disabled={!action.enabled} onClick={() => void run(pr, "security")}>{REVIEW_ACTION_LABELS.security}</PremiumButton>
                        <PremiumButton size="small" title={action.help} disabled={!action.enabled} onClick={() => void run(pr, "code")}>{REVIEW_ACTION_LABELS.code}</PremiumButton>
                        <PremiumButton size="small" variant="primary" title={action.help} disabled={!action.enabled} onClick={() => void run(pr, "both")}>{busy === key ? "Queuing…" : REVIEW_ACTION_LABELS.both}</PremiumButton>
                      </div>
                      {!action.enabled && <div className="review-console__action-help">{action.help}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  return <AuthGuard><ReviewsInner /></AuthGuard>;
}
