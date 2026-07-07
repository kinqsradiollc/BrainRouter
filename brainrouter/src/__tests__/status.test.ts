import { describe, expect, it } from "vitest";
import { collectSystemStatus, overallStatus } from "../observability/status.js";

const base = { service: "brain", serveRest: true, serveMcp: true, uptimeSec: 42, checkedAt: "2026-07-07T00:00:00.000Z" };

describe("SYSTEM-STATUS aggregation (single gateway)", () => {
  it("overallStatus takes the worst component", () => {
    expect(overallStatus([{ id: "a", label: "A", status: "operational" }])).toBe("operational");
    expect(overallStatus([
      { id: "a", label: "A", status: "operational" },
      { id: "b", label: "B", status: "degraded" },
    ])).toBe("degraded");
    expect(overallStatus([
      { id: "a", label: "A", status: "degraded" },
      { id: "b", label: "B", status: "down" },
    ])).toBe("down");
    expect(overallStatus([])).toBe("operational");
  });

  it("reports operational when the DB is reachable and both planes are served", async () => {
    const s = await collectSystemStatus({ ...base, pingDb: async () => true });
    expect(s.status).toBe("operational");
    expect(s.service).toBe("brain");
    expect(s.uptimeSec).toBe(42);
    const ids = s.components.map((c) => c.id);
    expect(ids).toEqual(["gateway", "api", "mcp", "database", "memory"]);
    expect(s.components.every((c) => c.status === "operational")).toBe(true);
  });

  it("goes down (DB) + degraded (memory) when the store is unreachable", async () => {
    const s = await collectSystemStatus({ ...base, pingDb: async () => false });
    expect(s.status).toBe("down"); // database down dominates
    expect(s.components.find((c) => c.id === "database")?.status).toBe("down");
    expect(s.components.find((c) => c.id === "memory")?.status).toBe("degraded");
  });

  it("a throwing DB probe is treated as down, never propagates", async () => {
    const s = await collectSystemStatus({ ...base, pingDb: async () => { throw new Error("boom"); } });
    expect(s.components.find((c) => c.id === "database")?.status).toBe("down");
  });

  it("omits planes this process does not serve (split-service mode)", async () => {
    const s = await collectSystemStatus({ ...base, serveMcp: false, pingDb: async () => true });
    const ids = s.components.map((c) => c.id);
    expect(ids).toContain("api");
    expect(ids).not.toContain("mcp");
  });
});
