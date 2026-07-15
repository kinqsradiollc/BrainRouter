import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewPullRequest } from "../../lib/adminApi";
import {
  filterReviewPullRequests,
  reviewActionPresentation,
  reviewsReturnPath,
  safeReviewsReturnPath,
} from "./reviewPresentation";

function pullRequest(overrides: Partial<ReviewPullRequest> = {}): ReviewPullRequest {
  return {
    repo: "acme/widgets",
    number: 7,
    title: "Keep manual reviews available",
    author: "octocat",
    headSha: "abc123",
    updatedAt: "2026-07-14T01:00:00.000Z",
    createdAt: "2026-07-13T01:00:00.000Z",
    url: "https://github.com/acme/widgets/pull/7",
    state: "open",
    draft: false,
    comments: 2,
    labels: ["security"],
    availability: {
      accountConnected: true,
      repositoryAccessible: true,
      autoReviewEnabled: false,
    },
    security: null,
    code: null,
    ...overrides,
  };
}

test("manual-only account repositories remain in the operational PR list", () => {
  const manual = pullRequest();
  const automatic = pullRequest({
    repo: "acme/api",
    number: 8,
    availability: { accountConnected: false, repositoryAccessible: true, autoReviewEnabled: true },
  });
  const filters = { query: "", repository: "all", author: "all", label: "all", draft: "all", status: "all", automation: "all", sort: "updated-desc" } as const;
  assert.deepEqual(filterReviewPullRequests([manual, automatic], filters), [manual, automatic]);
  assert.deepEqual(filterReviewPullRequests([manual, automatic], { ...filters, automation: "on-demand" }), [manual]);
});

test("review actions use the same RBAC and repository disabled reasons as desktop", () => {
  const availability = pullRequest().availability;
  assert.deepEqual(reviewActionPresentation(false, availability), {
    enabled: false,
    help: "Your role can view reviews but needs the reviews:run capability to start one.",
  });
  assert.deepEqual(reviewActionPresentation(true, { ...availability, repositoryAccessible: false }), {
    enabled: false,
    help: "The repository could not be resolved for this change request.",
  });
  assert.equal(reviewActionPresentation(true, availability).enabled, true);
});

test("list state is preserved in safe review detail return links", () => {
  const path = reviewsReturnPath({ query: "auth", repository: "acme/widgets", author: "octocat", label: "security", draft: "ready", status: "attention", automation: "on-demand", sort: "comments-desc" }, "org-1");
  assert.equal(path, "/reviews?org=org-1&q=auth&repository=acme%2Fwidgets&author=octocat&label=security&draft=ready&status=attention&automation=on-demand&sort=comments-desc");
  assert.equal(safeReviewsReturnPath(path), path);
  assert.equal(safeReviewsReturnPath("https://malicious.example/reviews"), "/reviews");
  assert.equal(safeReviewsReturnPath("/reviews/pr?repo=acme/widgets"), "/reviews");
});

test("GitHub-style filters combine author, label, and draft state", () => {
  const ready = pullRequest();
  const draft = pullRequest({ repo: "acme/api", number: 8, author: "hubot", draft: true, labels: ["dependencies"] });
  const filters = { query: "", repository: "all", author: "octocat", label: "security", draft: "ready", status: "all", automation: "all", sort: "updated-desc" } as const;
  assert.deepEqual(filterReviewPullRequests([draft, ready], filters), [ready]);
});

test("GitHub-style sorting supports timestamps and comment activity", () => {
  const oldest = pullRequest({ number: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", comments: 10 });
  const newest = pullRequest({ number: 2, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", comments: 2 });
  const base = { query: "", repository: "all", author: "all", label: "all", draft: "all", status: "all", automation: "all" } as const;
  assert.deepEqual(filterReviewPullRequests([oldest, newest], { ...base, sort: "created-desc" }).map((pr) => pr.number), [2, 1]);
  assert.deepEqual(filterReviewPullRequests([oldest, newest], { ...base, sort: "created-asc" }).map((pr) => pr.number), [1, 2]);
  assert.deepEqual(filterReviewPullRequests([oldest, newest], { ...base, sort: "comments-desc" }).map((pr) => pr.number), [1, 2]);
});
