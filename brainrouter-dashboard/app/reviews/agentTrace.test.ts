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

test("the units the review planned and what the reflection dropped are visible", () => {
  // ADR-033 — a reviewer that reports how it ran and then hides the numbers is
  // the surface failure this project keeps having; these events are emitted, so
  // they must reach the trace.
  const trace = buildAgentTrace([review({ progress: [
    { ts: "2026-07-15T00:00:00.000Z", kind: "queued", msg: "Security review started" },
    { ts: "2026-07-15T00:00:01.000Z", kind: "diff-fetched", msg: "PR diff fetched", data: { bytes: 1200, files: 4 } },
    { ts: "2026-07-15T00:00:02.000Z", kind: "review-units-planned", msg: "Review planned as 2 unit(s)", data: { parts: 2, graphEdges: 1, deferredFiles: ["src/skipped.ts"] } },
    { ts: "2026-07-15T00:00:04.000Z", kind: "findings-parsed", msg: "Findings parsed", data: { total: 3, droppedByReflection: 2, reflected: true } },
  ] })]);
  const context = trace.nodes.find((node) => node.label === "Pull request context");
  assert.equal(context?.metrics.parts, 2);
  assert.equal(context?.metrics.graphEdges, 1);
  // Path lists are not scalars and never reach the trace.
  assert.equal(context?.metrics.deferredFiles, undefined);
  const findings = trace.nodes.find((node) => node.label === "Finding analysis");
  assert.equal(findings?.metrics.droppedByReflection, 2);
  assert.equal(findings?.metrics.reflected, true);
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

test("pentest progress events group into pentest phases with the last active while running", () => {
  const run = review({
    id: "pentest-1", lens: "pentest", status: "running", repo: "http://localhost:3000", prNumber: null,
    findings: 0, blocking: 0, updatedAt: "2026-07-15T00:01:00.000Z",
    progress: [
      { ts: "2026-07-15T00:00:00.000Z", kind: "perimeter", msg: "Starting Standard Pentest", data: { scanMode: "standard" } },
      { ts: "2026-07-15T00:00:05.000Z", kind: "status", msg: "Thinking (turn 1)..." },
      { ts: "2026-07-15T00:00:06.000Z", kind: "tool-start", msg: "run_command" },
      { ts: "2026-07-15T00:00:08.000Z", kind: "tool-end", msg: "curl -s http://localhost:3000/", data: { tool: "run_command", success: true } },
      { ts: "2026-07-15T00:01:00.000Z", kind: "worker", msg: "recon completed", data: { childId: "w1" } },
    ],
  });
  const trace = buildAgentTrace([run]);
  assert.equal(trace.nodes[0]?.label, "Pentest reviewer");
  const labels = trace.nodes.filter((node) => node.kind === "phase").map((node) => node.label);
  assert.deepEqual(labels, ["Perimeter setup", "Recon & analysis", "Tool execution", "Sub-agents"]);
  // The tool-execution phase surfaces the tool name as a safe metric.
  assert.equal(trace.nodes.find((node) => node.label === "Tool execution")?.metrics.tool, "run_command");
  // Only the final phase is active while the run is still going.
  assert.equal(trace.nodes.find((node) => node.label === "Sub-agents")?.status, "running");
  assert.equal(trace.nodes.find((node) => node.label === "Perimeter setup")?.status, "succeeded");
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
