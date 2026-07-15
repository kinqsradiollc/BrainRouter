import type { ReviewJob } from "../../lib/adminApi";

export type AgentTraceStatus = "waiting" | "running" | "succeeded" | "failed" | "skipped";

export interface AgentTraceNode {
  id: string;
  parentId: string | null;
  kind: "agent" | "phase";
  label: string;
  description: string;
  status: AgentTraceStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  metrics: Record<string, string | number | boolean>;
}

export interface AgentTrace {
  roots: string[];
  nodes: AgentTraceNode[];
}

const ACTIVE = new Set(["pending", "queued", "running"]);
const FAILED = new Set(["failed", "error", "cancelled"]);
const SAFE_METRICS = new Set([
  "bytes", "truncated", "files", "ms", "total", "blocking", "n", "skippedAnchors",
  "conclusion", "sources", "unhealthySources", "exactExposures", "diffReferencedCves",
  "entries", "cacheState", "fetchedAt", "source",
]);

const PHASES = [
  { id: "authorization", label: "Authorization", kinds: new Set(["queued", "token-resolved", "token-minted"]) },
  { id: "context", label: "Pull request context", kinds: new Set(["head-resolved", "diff-fetched"]) },
  { id: "intelligence", label: "Vulnerability intelligence", kinds: new Set(["intelligence-ready", "intelligence-unavailable"]) },
  { id: "analysis", label: "Model analysis", kinds: new Set(["llm-started", "llm-finished"]) },
  { id: "findings", label: "Finding analysis", kinds: new Set(["findings-parsed"]) },
  { id: "publishing", label: "GitHub publishing", kinds: new Set(["inline-posted", "summary-posted", "review-posted", "approved", "check-posted"]) },
  { id: "complete", label: "Complete", kinds: new Set(["done"]) },
] as const;

type ProgressEvent = NonNullable<ReviewJob["progress"]>[number];

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lensLabel(lens: ReviewJob["lens"]): string {
  if (lens === "security") return "Security reviewer";
  if (lens === "code") return "Code reviewer";
  return "Pentest reviewer";
}

function jobStatus(job: ReviewJob): AgentTraceStatus {
  const normalized = job.status.toLowerCase();
  if (job.error || FAILED.has(normalized)) return "failed";
  if (job.skipped) return "skipped";
  if (ACTIVE.has(normalized)) return "running";
  return "succeeded";
}

function safeMetrics(events: ProgressEvent[]): Record<string, string | number | boolean> {
  const metrics: Record<string, string | number | boolean> = {};
  for (const event of events) {
    for (const [key, value] of Object.entries(event.data ?? {})) {
      if (SAFE_METRICS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) metrics[key] = value;
    }
  }
  return metrics;
}

function phaseNode(job: ReviewJob, phase: typeof PHASES[number], events: ProgressEvent[], active: boolean): AgentTraceNode {
  const first = events[0];
  const last = events.at(-1);
  const firstMs = time(first?.ts);
  const lastMs = time(last?.ts);
  let explicitDuration: unknown;
  for (let index = events.length - 1; index >= 0; index--) {
    const value = events[index]?.durationMs ?? events[index]?.data?.ms;
    if (typeof value === "number") { explicitDuration = value; break; }
  }
  const failed = events.some((event) => event.kind === "error" || event.status === "failed");
  const skipped = events.some((event) => event.kind.endsWith("-unavailable") || event.status === "skipped");
  return {
    id: `${job.id}:${phase.id}`,
    parentId: job.id,
    kind: "phase",
    label: phase.label,
    description: last?.msg ?? phase.label,
    status: failed ? "failed" : skipped ? "skipped" : active ? "running" : "succeeded",
    startedAt: first?.ts ?? null,
    endedAt: active ? null : last?.ts ?? null,
    durationMs: typeof explicitDuration === "number" ? explicitDuration : firstMs !== null && lastMs !== null && firstMs !== lastMs ? Math.max(0, lastMs - firstMs) : null,
    metrics: safeMetrics(events),
  };
}

export function buildAgentTrace(reviews: ReviewJob[]): AgentTrace {
  const nodes: AgentTraceNode[] = [];
  const roots: string[] = [];
  for (const job of reviews) {
    const events = [...(job.progress ?? [])].sort((left, right) => (time(left.ts) ?? 0) - (time(right.ts) ?? 0));
    const status = jobStatus(job);
    roots.push(job.id);
    nodes.push({
      id: job.id,
      parentId: null,
      kind: "agent",
      label: lensLabel(job.lens),
      description: job.error ?? (job.skipped ? `Skipped: ${job.skipped}` : `${job.findings ?? 0} findings, ${job.blocking ?? 0} blocking`),
      status,
      startedAt: events[0]?.ts ?? job.createdAt,
      endedAt: status === "running" ? null : events.at(-1)?.ts ?? job.updatedAt,
      durationMs: status === "running" ? null : (() => {
        const start = time(events[0]?.ts ?? job.createdAt);
        const end = time(events.at(-1)?.ts ?? job.updatedAt);
        return start !== null && end !== null ? Math.max(0, end - start) : null;
      })(),
      metrics: { findings: job.findings ?? 0, blocking: job.blocking ?? 0 },
    });

    const grouped = PHASES.map((phase) => ({ phase, events: events.filter((event) => phase.kinds.has(event.kind as never)) })).filter((entry) => entry.events.length > 0);
    grouped.forEach((entry, index) => nodes.push(phaseNode(job, entry.phase, entry.events, status === "running" && index === grouped.length - 1)));
    const errors = events.filter((event) => event.kind === "error");
    if (errors.length) {
      const failedPhase = { id: "failed", label: "Failed", kinds: new Set<string>() };
      nodes.push(phaseNode(job, failedPhase as typeof PHASES[number], errors, false));
    }
  }
  return { roots, nodes };
}
