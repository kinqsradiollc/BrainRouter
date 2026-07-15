import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewJob } from "../../lib/adminApi";
import { buildAgentTrace } from "./agentTrace";

function review(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    id: "review-1",
    lens: "security",
    status: "done",
    repo: "acme/widgets",
    prNumber: 7,
    findings: 1,
    blocking: 0,
    skipped: null,
    error: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:05.000Z",
    progress: [
      { ts: "2026-07-15T00:00:00.000Z", kind: "queued", msg: "Security review started" },
      { ts: "2026-07-15T00:00:01.000Z", kind: "diff-fetched", msg: "PR diff fetched", data: { bytes: 1200, token: "never expose" } },
      { ts: "2026-07-15T00:00:02.000Z", kind: "llm-started", msg: "Review model started" },
      { ts: "2026-07-15T00:00:04.000Z", kind: "llm-finished", msg: "Review model finished", data: { ms: 2000 } },
      { ts: "2026-07-15T00:00:05.000Z", kind: "done", msg: "Review completed" },
    ],
    ...overrides,
  };
}

test("legacy progress events assemble into an ordered trace without sensitive metrics", () => {
  const trace = buildAgentTrace([review()]);
  assert.equal(trace.roots.length, 1);
  assert.deepEqual(trace.nodes.map((node) => node.label), ["Security reviewer", "Authorization", "Pull request context", "Model analysis", "Complete"]);
  assert.equal(trace.nodes[0]?.status, "succeeded");
  assert.deepEqual(trace.nodes.find((node) => node.label === "Pull request context")?.metrics, { bytes: 1200 });
});

test("running jobs mark only their last phase active", () => {
  const trace = buildAgentTrace([review({ status: "running", updatedAt: "2026-07-15T00:00:04.000Z", progress: [
    { ts: "2026-07-15T00:00:00.000Z", kind: "queued", msg: "Review started" },
    { ts: "2026-07-15T00:00:02.000Z", kind: "llm-started", msg: "Review model started" },
  ] })]);
  assert.equal(trace.nodes[0]?.status, "running");
  assert.equal(trace.nodes.find((node) => node.label === "Authorization")?.status, "succeeded");
  assert.equal(trace.nodes.find((node) => node.label === "Model analysis")?.status, "running");
});

test("failures and distinct lenses remain visible as separate roots", () => {
  const failed = review({ status: "failed", error: "model timeout", progress: [
    { ts: "2026-07-15T00:00:00.000Z", kind: "queued", msg: "Security review started" },
    { ts: "2026-07-15T00:00:02.000Z", kind: "error", msg: "model timeout" },
  ] });
  const code = review({ id: "review-2", lens: "code", findings: 0, progress: [] });
  const trace = buildAgentTrace([failed, code]);
  assert.deepEqual(trace.roots, ["review-1", "review-2"]);
  assert.equal(trace.nodes.find((node) => node.id === "review-1")?.status, "failed");
  assert.equal(trace.nodes.find((node) => node.parentId === "review-1" && node.label === "Failed")?.status, "failed");
  assert.equal(trace.nodes.find((node) => node.id === "review-2")?.label, "Code reviewer");
});
