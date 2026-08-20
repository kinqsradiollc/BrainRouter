/**
 * ADR-041 A41-7 — the MCP tool-handler registry seam. Proves the strangler
 * dispatch on the first batch migrated out of the mcpServer.ts switch (skill /
 * persona / reference / template / workspace-profile tools). The full round-trip
 * (parse → handler → MCP result bytes) is covered end-to-end by
 * mcpServer.knowledge.test.ts and mcpServer.profile-recommend.test.ts, which now
 * exercise these tools THROUGH this registry.
 */
import { describe, expect, it } from "vitest";
import {
  mcpToolHandler,
  registeredMcpToolNames,
  registerMcpTool,
  type McpToolContext,
} from "./index.js";

const MIGRATED = [
  // batch 1 — skills / docs / workspace
  "list_skills",
  "get_skill",
  "search_skills",
  "create_skill",
  "update_skill",
  "get_persona",
  "get_reference",
  "list_template_docs",
  "get_template_doc",
  "workspace_profile_recommend",
  // batch 2 — memory / atlas / fleet (direct, multi-case blocks, atlas, admin-gated)
  "memory_recall",
  "memory_search",
  "memory_capture_turn",
  "memory_get", // governance block
  "memory_task_state", // engineering block
  "memory_hook_status", // hook block
  "memory_working_reset", // working block
  "memory_persona",
  "memory_stats",
  "atlas_put",
  "fleet_snapshot_get",
  "memory_register_skill_hints",
  "memory_skill_outcome",
  // batch 3 — vulnerability intelligence + connector + knowledge (actor-gated)
  "vulnerability_intelligence",
  "connector_list",
  "connector_run",
  "knowledge_list",
  "knowledge_search",
];

// Tools that deliberately REMAIN in the mcpServer.ts switch: session_* close over
// the per-connection delivery hub + connection claim (the next, final slice).
const STILL_IN_SWITCH = ["session_register", "session_send", "session_heartbeat", "session_delegations"];

describe("A41-7 MCP tool registry", () => {
  it("registers every tool in the first migrated batch", () => {
    for (const name of MIGRATED) {
      expect(mcpToolHandler(name), `${name} has a registered handler`).toBeTypeOf("function");
      expect(registeredMcpToolNames().has(name), `${name} is in the registered set`).toBe(true);
    }
  });

  it("returns undefined for a tool still living in the switch (or unknown)", () => {
    for (const name of STILL_IN_SWITCH) {
      expect(mcpToolHandler(name), `${name} must fall through to the switch`).toBeUndefined();
    }
    expect(mcpToolHandler("definitely_not_a_tool")).toBeUndefined();
  });

  it("refuses a duplicate registration — a tool has one home", () => {
    expect(() => registerMcpTool("list_skills", async () => ({}))).toThrow(/Duplicate MCP tool handler/);
  });

  it("gates create_skill / update_skill on the admin flag, byte-identically to the former switch", async () => {
    // The admin gate throws BEFORE touching the registry, so a bare host suffices.
    const ctx = (isAdmin: boolean): McpToolContext => ({
      args: {},
      invokedName: "create_skill",
      host: { registry: {} as never, isAdmin, defaultUserId: "u", defaultOrgId: undefined, connectorWorkspaceRoot: "/tmp", knowledgeActor: null },
    });
    await expect(mcpToolHandler("create_skill")!(ctx(false))).rejects.toThrow(
      /Admin access required for this tool/,
    );
    await expect(mcpToolHandler("update_skill")!(ctx(false))).rejects.toThrow(
      /Admin access required for this tool/,
    );
  });
});
