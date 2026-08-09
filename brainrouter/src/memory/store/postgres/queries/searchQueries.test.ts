import { describe, expect, it, vi } from "vitest";
import { applyFilters } from "../../../recall/filters.js";
import { searchCognitiveFts, searchCognitiveFtsAsOf, searchCognitiveVec } from "./searchQueries.js";

const sharedRow = {
  record_id: "shared-record",
  user_id: "owner-user",
  org_id: "org-1",
  visibility: "org",
  workspace_tag: "workspace-owner",
  project_tag: "project-owner",
  content: "Shared implementation detail",
  type: "semantic",
  priority: 70,
  scene_name: "",
  skill_tag: "",
  session_key: "owner-session",
  timestamp_str: "",
  created_time: "2026-07-13T00:00:00.000Z",
  citation_count: 0,
  rank: 0.8,
  distance: 0.2,
};

const scope = {
  orgId: "org-1",
  callerUserId: "caller-user",
  workspaceTag: "workspace-caller",
  projectTag: "project-caller",
  scope: "project" as const,
};

describe("org-shared recall candidate scope tags", () => {
  it("requires the pinned org for learned FTS rows and excludes them without one", async () => {
    const withOrg = { rows: vi.fn(async () => []) } as any;
    await searchCognitiveFts(withOrg, "caller-user", "implementation detail", 10, "org-1");
    expect(withOrg.rows.mock.calls[0]![0]).toContain("r.metadata_json::jsonb -> 'learned' IS NULL OR r.org_id = $4");
    expect(withOrg.rows.mock.calls[0]![1]).toEqual(["caller-user", "implementation detail", 10, "org-1"]);

    const withoutOrg = { rows: vi.fn(async () => []) } as any;
    await searchCognitiveFts(withoutOrg, "caller-user", "implementation detail", 10);
    const sql = withoutOrg.rows.mock.calls[0]![0] as string;
    expect(sql).toContain("r.metadata_json::jsonb -> 'learned' IS NULL");
    expect(sql).not.toContain("OR r.org_id =");
  });

  it("pins point-in-time learned search to the active org", async () => {
    const exec = { rows: vi.fn(async () => []) } as any;
    await searchCognitiveFtsAsOf(
      exec,
      "caller-user",
      "implementation detail",
      10,
      "2026-08-09T00:00:00.000Z",
      "org-1",
    );
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("r.metadata_json::jsonb -> 'learned' IS NULL OR r.org_id = $5");
    expect(params).toEqual([
      "caller-user", "implementation detail", "2026-08-09T00:00:00.000Z", 10, "org-1",
    ]);
  });

  it("uses team membership rather than treating team visibility as organization-wide", async () => {
    const exec = { rows: vi.fn(async () => [{ ...sharedRow, visibility: "team", team_access: true }]) } as any;
    const results = await searchCognitiveFts(exec, "caller-user", "implementation detail", 10, "org-1");
    const sql = exec.rows.mock.calls[0]![0] as string;
    expect(sql).toContain("JOIN team_members access_member");
    expect(sql).toContain("access_team.kind = 'personal'");
    expect((results[0] as any).team_access).toBe(true);
  });

  it("retains FTS workspace/project tags so a mismatched shared record is filtered", async () => {
    const exec = { rows: vi.fn(async () => [sharedRow]) } as any;

    const results = await searchCognitiveFts(exec, "caller-user", "implementation detail", 10, "org-1");

    expect((results[0] as any).workspace_tag).toBe("workspace-owner");
    expect((results[0] as any).project_tag).toBe("project-owner");
    expect(applyFilters(results, scope)).toEqual([]);
  });

  it("retains vector workspace/project tags so a mismatched shared record is filtered", async () => {
    const exec = { rows: vi.fn(async () => [sharedRow]) } as any;
    const vec = {
      vecReady: true,
      vecDimensions: 2,
      initVec: vi.fn(async () => {}),
    };

    const results = await searchCognitiveVec(exec, vec, "caller-user", new Float32Array([0.1, 0.2]), 10, "org-1");

    expect((results[0] as any).workspace_tag).toBe("workspace-owner");
    expect((results[0] as any).project_tag).toBe("project-owner");
    expect(applyFilters(results, scope)).toEqual([]);
  });
});
