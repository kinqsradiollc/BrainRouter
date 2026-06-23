/**
 * REMOTE-BRAIN Phase 4 — lightweight, dependency-free observability for the
 * brain. An in-process registry counts HTTP requests and MCP tool calls (with
 * durations) so operators get visibility on the remote transport without
 * pulling in a metrics client. Rendered as Prometheus text (the scrape
 * standard) or JSON via the `/metrics` endpoint. Auth + per-user `userId`
 * pinning already exist; this is the metrics/logging half of Phase 4.
 *
 * Cardinality is bounded by design: HTTP is keyed by a small set of route
 * BUCKETS (not raw paths) + status; tool calls by tool name + ok/error.
 */

interface DurAgg { sum: number; count: number }

const httpRequests = new Map<string, number>(); // `${route}|${status}` → count
const httpDuration = new Map<string, DurAgg>(); // `${route}` → {sum,count}
const toolCalls = new Map<string, number>(); // `${tool}|${ok|error}` → count
const toolDuration = new Map<string, DurAgg>(); // `${tool}` → {sum,count}
let startedAtMs = Date.now();

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}
function aggregate(m: Map<string, DurAgg>, key: string, ms: number): void {
  const a = m.get(key) ?? { sum: 0, count: 0 };
  a.sum += ms;
  a.count += 1;
  m.set(key, a);
}

/** Collapse a raw request path to a bounded route bucket (keeps label cardinality low). */
export function routeBucket(method: string, path: string): string {
  const p = (path.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  if (p === "/mcp") return `${method} /mcp`;
  if (p === "/health") return `${method} /health`;
  if (p === "/metrics") return `${method} /metrics`;
  if (p.startsWith("/api/")) {
    // /api/<group>/... → "/api/<group>" so per-id paths don't explode cardinality.
    const seg = p.split("/").filter(Boolean); // ["api","memories",...]
    return `${method} /api/${seg[1] ?? ""}`;
  }
  return `${method} other`;
}

/** Record one completed HTTP request. */
export function recordHttp(route: string, status: number, ms: number): void {
  bump(httpRequests, `${route}|${status}`);
  aggregate(httpDuration, route, ms);
}

/** Record one completed MCP tool call. */
export function recordToolCall(tool: string, ok: boolean, ms: number): void {
  bump(toolCalls, `${tool}|${ok ? "ok" : "error"}`);
  aggregate(toolDuration, tool, ms);
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  http: { requests: Record<string, number>; durationMs: Record<string, DurAgg> };
  mcp: { toolCalls: Record<string, number>; durationMs: Record<string, DurAgg> };
}

export function metricsSnapshot(): MetricsSnapshot {
  return {
    uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    http: { requests: Object.fromEntries(httpRequests), durationMs: Object.fromEntries(httpDuration) },
    mcp: { toolCalls: Object.fromEntries(toolCalls), durationMs: Object.fromEntries(toolDuration) },
  };
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Render the registry as Prometheus text exposition format. */
export function renderPrometheus(): string {
  const lines: string[] = [];
  lines.push("# HELP brainrouter_http_requests_total HTTP requests by route bucket and status.");
  lines.push("# TYPE brainrouter_http_requests_total counter");
  for (const [key, n] of httpRequests) {
    const [route, status] = key.split("|");
    lines.push(`brainrouter_http_requests_total{route="${esc(route)}",status="${esc(status)}"} ${n}`);
  }
  lines.push("# HELP brainrouter_http_request_duration_ms Request duration sum/count by route bucket.");
  lines.push("# TYPE brainrouter_http_request_duration_ms summary");
  for (const [route, a] of httpDuration) {
    lines.push(`brainrouter_http_request_duration_ms_sum{route="${esc(route)}"} ${a.sum}`);
    lines.push(`brainrouter_http_request_duration_ms_count{route="${esc(route)}"} ${a.count}`);
  }
  lines.push("# HELP brainrouter_mcp_tool_calls_total MCP tool calls by tool and result.");
  lines.push("# TYPE brainrouter_mcp_tool_calls_total counter");
  for (const [key, n] of toolCalls) {
    const [tool, result] = key.split("|");
    lines.push(`brainrouter_mcp_tool_calls_total{tool="${esc(tool)}",result="${esc(result)}"} ${n}`);
  }
  lines.push("# HELP brainrouter_mcp_tool_duration_ms MCP tool-call duration sum/count by tool.");
  lines.push("# TYPE brainrouter_mcp_tool_duration_ms summary");
  for (const [tool, a] of toolDuration) {
    lines.push(`brainrouter_mcp_tool_duration_ms_sum{tool="${esc(tool)}"} ${a.sum}`);
    lines.push(`brainrouter_mcp_tool_duration_ms_count{tool="${esc(tool)}"} ${a.count}`);
  }
  lines.push("# HELP brainrouter_process_uptime_seconds Seconds since the metrics registry started.");
  lines.push("# TYPE brainrouter_process_uptime_seconds gauge");
  lines.push(`brainrouter_process_uptime_seconds ${Math.round((Date.now() - startedAtMs) / 1000)}`);
  return lines.join("\n") + "\n";
}

/** Test hook — clear all counters + reset the start time. */
export function resetMetricsForTests(): void {
  httpRequests.clear();
  httpDuration.clear();
  toolCalls.clear();
  toolDuration.clear();
  startedAtMs = Date.now();
}
