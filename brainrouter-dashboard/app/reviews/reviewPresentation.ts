import type {
  ManualReviewRunRequest,
  RepositoryReviewAvailability,
} from "@kinqs/brainrouter-types";
import { manualDeepReviewRequestConfig } from "@kinqs/brainrouter-types/review";
import type { ReviewJob, ReviewPullRequest } from "../../lib/adminApi";

export type ReviewStatusFilter = "all" | "attention" | "running" | "complete" | "not-reviewed";
export type ReviewAutomationFilter = "all" | "automatic" | "on-demand";
export type ReviewDraftFilter = "all" | "ready" | "draft";
export type ReviewSort = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "comments-desc";
export type ReviewExecutionMode = "diff" | "deep";
export type ReviewRunLens = "security" | "code" | "both";

export const REVIEW_ACTION_LABELS = {
  security: "Security review",
  code: "Code review",
  both: "Run both",
} as const;

export interface ReviewListFilters {
  query: string;
  repository: string;
  author: string;
  label: string;
  draft: ReviewDraftFilter;
  status: ReviewStatusFilter;
  automation: ReviewAutomationFilter;
  sort: ReviewSort;
}

export interface ReviewActionPresentation {
  enabled: boolean;
  help: string;
}

export function manualReviewRunRequest(
  repo: string,
  prNumber: number,
  lens: ReviewRunLens,
  mode: ReviewExecutionMode,
  limitsAccepted: boolean,
): ManualReviewRunRequest {
  if (mode === "deep" && !limitsAccepted) {
    throw new Error("Accept the displayed deep-review limits before starting this run.");
  }
  return mode === "deep"
    ? {
        repo,
        prNumber,
        lens,
        mode,
        deepReview: manualDeepReviewRequestConfig(),
      }
    : { repo, prNumber, lens, mode: "diff" };
}

const ACTIVE_STATUSES = new Set(["pending", "queued", "running"]);
const COMPLETE_STATUSES = new Set(["done", "completed", "succeeded"]);
const FAILED_STATUSES = new Set(["error", "failed", "cancelled"]);

function normalizedStatus(job: ReviewJob | null): string {
  return String(job?.status ?? "").trim().toLowerCase();
}

function jobsFor(pr: ReviewPullRequest): ReviewJob[] {
  return [pr.security, pr.code].filter((job): job is ReviewJob => Boolean(job));
}

export function reviewNeedsAttention(pr: ReviewPullRequest): boolean {
  return jobsFor(pr).some((job) => Boolean(job.error) || (job.blocking ?? 0) > 0 || FAILED_STATUSES.has(normalizedStatus(job)));
}

export function reviewIsRunning(pr: ReviewPullRequest): boolean {
  return jobsFor(pr).some((job) => ACTIVE_STATUSES.has(normalizedStatus(job)));
}

export function reviewStatus(pr: ReviewPullRequest): { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "info" } {
  const jobs = jobsFor(pr);
  if (reviewNeedsAttention(pr)) return { label: "Needs attention", tone: "danger" };
  if (reviewIsRunning(pr)) return { label: "Review running", tone: "info" };
  const completed = jobs.filter((job) => COMPLETE_STATUSES.has(normalizedStatus(job))).length;
  if (completed === 2) return { label: "Both complete", tone: "ok" };
  if (completed === 1) return { label: "One complete", tone: "warn" };
  return { label: "Not reviewed", tone: "neutral" };
}

export function reviewActionPresentation(
  canRun: boolean,
  availability: RepositoryReviewAvailability,
  busy = false,
): ReviewActionPresentation {
  if (busy) return { enabled: false, help: "A review is already being queued for this pull request." };
  if (!canRun) {
    return {
      enabled: false,
      help: "Your role can view reviews but needs the reviews:run capability to start one.",
    };
  }
  if (!availability.repositoryAccessible) {
    return {
      enabled: false,
      help: "The repository could not be resolved for this change request.",
    };
  }
  return {
    enabled: true,
    help: "Runs with your organization policy and posts the result to this pull request.",
  };
}

export function filterReviewPullRequests(prs: ReviewPullRequest[], filters: ReviewListFilters): ReviewPullRequest[] {
  const query = filters.query.trim().toLowerCase();
  const filtered = prs.filter((pr) => {
    if (filters.repository !== "all" && pr.repo !== filters.repository) return false;
    if (filters.author !== "all" && pr.author !== filters.author) return false;
    if (filters.label !== "all" && !pr.labels.includes(filters.label)) return false;
    if (filters.draft === "draft" && !pr.draft) return false;
    if (filters.draft === "ready" && pr.draft) return false;
    if (filters.automation === "automatic" && !pr.availability.autoReviewEnabled) return false;
    if (filters.automation === "on-demand" && pr.availability.autoReviewEnabled) return false;
    if (filters.status === "attention" && !reviewNeedsAttention(pr)) return false;
    if (filters.status === "running" && !reviewIsRunning(pr)) return false;
    if (filters.status === "complete" && reviewStatus(pr).tone !== "ok") return false;
    if (filters.status === "not-reviewed" && jobsFor(pr).length > 0) return false;
    if (!query) return true;
    return [pr.repo, pr.title, pr.author ?? "", String(pr.number), ...pr.labels]
      .some((value) => value.toLowerCase().includes(query));
  });
  const time = (value: string | null): number => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...filtered].sort((left, right) => {
    if (filters.sort === "updated-asc") return time(left.updatedAt) - time(right.updatedAt);
    if (filters.sort === "created-desc") return time(right.createdAt) - time(left.createdAt);
    if (filters.sort === "created-asc") return time(left.createdAt) - time(right.createdAt);
    if (filters.sort === "comments-desc") return right.comments - left.comments || time(right.updatedAt) - time(left.updatedAt);
    return time(right.updatedAt) - time(left.updatedAt);
  });
}

export function reviewsReturnPath(filters: ReviewListFilters, orgId?: string): string {
  const query = new URLSearchParams();
  if (orgId) query.set("org", orgId);
  if (filters.query.trim()) query.set("q", filters.query.trim());
  if (filters.repository !== "all") query.set("repository", filters.repository);
  if (filters.author !== "all") query.set("author", filters.author);
  if (filters.label !== "all") query.set("label", filters.label);
  if (filters.draft !== "all") query.set("draft", filters.draft);
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.automation !== "all") query.set("automation", filters.automation);
  if (filters.sort !== "updated-desc") query.set("sort", filters.sort);
  const encoded = query.toString();
  return encoded ? `/reviews?${encoded}` : "/reviews";
}

export function safeReviewsReturnPath(value: string | null): string {
  if (!value) return "/reviews";
  return value === "/reviews" || value.startsWith("/reviews?") ? value : "/reviews";
}
