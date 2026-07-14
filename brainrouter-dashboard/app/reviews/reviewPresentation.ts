import type { RepositoryReviewAvailability } from "@kinqs/brainrouter-types";
import type { ReviewJob, ReviewPullRequest } from "../../lib/adminApi";

export type ReviewStatusFilter = "all" | "attention" | "running" | "complete" | "not-reviewed";
export type ReviewAutomationFilter = "all" | "automatic" | "on-demand";

export const REVIEW_ACTION_LABELS = {
  security: "Security review",
  code: "Code review",
  both: "Run both",
} as const;

export interface ReviewListFilters {
  query: string;
  repository: string;
  status: ReviewStatusFilter;
  automation: ReviewAutomationFilter;
}

export interface ReviewActionPresentation {
  enabled: boolean;
  help: string;
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
  return prs.filter((pr) => {
    if (filters.repository !== "all" && pr.repo !== filters.repository) return false;
    if (filters.automation === "automatic" && !pr.availability.autoReviewEnabled) return false;
    if (filters.automation === "on-demand" && pr.availability.autoReviewEnabled) return false;
    if (filters.status === "attention" && !reviewNeedsAttention(pr)) return false;
    if (filters.status === "running" && !reviewIsRunning(pr)) return false;
    if (filters.status === "complete" && reviewStatus(pr).tone !== "ok") return false;
    if (filters.status === "not-reviewed" && jobsFor(pr).length > 0) return false;
    if (!query) return true;
    return [pr.repo, pr.title, pr.author ?? "", String(pr.number)]
      .some((value) => value.toLowerCase().includes(query));
  });
}

export function reviewsReturnPath(filters: ReviewListFilters, orgId?: string): string {
  const query = new URLSearchParams();
  if (orgId) query.set("org", orgId);
  if (filters.query.trim()) query.set("q", filters.query.trim());
  if (filters.repository !== "all") query.set("repository", filters.repository);
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.automation !== "all") query.set("automation", filters.automation);
  const encoded = query.toString();
  return encoded ? `/reviews?${encoded}` : "/reviews";
}

export function safeReviewsReturnPath(value: string | null): string {
  if (!value) return "/reviews";
  return value === "/reviews" || value.startsWith("/reviews?") ? value : "/reviews";
}
