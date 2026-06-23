import { beforeEach, describe, expect, it } from "vitest";
import {
  recordHttp,
  recordToolCall,
  routeBucket,
  metricsSnapshot,
  renderPrometheus,
  resetMetricsForTests,
} from "../observability/metrics.js";

describe("observability metrics", () => {
  beforeEach(() => resetMetricsForTests());

  it("buckets routes to bounded labels (no per-id explosion)", () => {
    expect(routeBucket("POST", "/mcp")).toBe("POST /mcp");
    expect(routeBucket("GET", "/health")).toBe("GET /health");
    expect(routeBucket("GET", "/api/memories/abc123")).toBe("GET /api/memories");
    expect(routeBucket("GET", "/api/scenes/")).toBe("GET /api/scenes");
    expect(routeBucket("GET", "/whatever")).toBe("GET other");
  });

  it("counts HTTP requests + tool calls in the snapshot", () => {
    recordHttp("POST /mcp", 200, 12);
    recordHttp("POST /mcp", 200, 8);
    recordHttp("POST /mcp", 500, 3);
    recordToolCall("memory_recall", true, 40);
    recordToolCall("memory_recall", false, 5);

    const s = metricsSnapshot();
    expect(s.http.requests["POST /mcp|200"]).toBe(2);
    expect(s.http.requests["POST /mcp|500"]).toBe(1);
    expect(s.http.durationMs["POST /mcp"]).toEqual({ sum: 23, count: 3 });
    expect(s.mcp.toolCalls["memory_recall|ok"]).toBe(1);
    expect(s.mcp.toolCalls["memory_recall|error"]).toBe(1);
    expect(s.mcp.durationMs["memory_recall"]).toEqual({ sum: 45, count: 2 });
  });

  it("renders Prometheus text with labels + escaping", () => {
    recordHttp("POST /mcp", 200, 10);
    recordToolCall("memory_recall", true, 40);
    const text = renderPrometheus();
    expect(text).toContain('brainrouter_http_requests_total{route="POST /mcp",status="200"} 1');
    expect(text).toContain('brainrouter_http_request_duration_ms_count{route="POST /mcp"} 1');
    expect(text).toContain('brainrouter_mcp_tool_calls_total{tool="memory_recall",result="ok"} 1');
    expect(text).toMatch(/brainrouter_process_uptime_seconds \d+/);
  });

  it("resets cleanly between runs", () => {
    recordHttp("POST /mcp", 200, 1);
    resetMetricsForTests();
    expect(metricsSnapshot().http.requests).toEqual({});
  });
});
