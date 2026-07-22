import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessibleProject: vi.fn(),
  listKnowledgeBases: vi.fn(),
  createKnowledgeBase: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    knowledge: {
      getAccessibleProject: mocks.getAccessibleProject,
      listKnowledgeBases: mocks.listKnowledgeBases,
      createKnowledgeBase: mocks.createKnowledgeBase,
    },
  },
}));

import { Registry } from "../registry.js";
import { buildMcpServer } from "./mcpServer.js";

const timestamp = "2026-07-22T01:02:03.000Z";
const base = {
  baseId: "kb-1",
  orgId: "org-a",
  projectId: "project-a",
  name: "Project docs",
  description: "Reviewed project knowledge",
  createdBy: "developer-1",
  createdAt: timestamp,
  updatedAt: timestamp,
};

function parseTextResult(result: unknown) {
  const content = (result as { content?: unknown })?.content as Array<{ text?: unknown }>;
  if (typeof content[0]?.text !== "string") throw new Error("Expected a text tool result");
  return JSON.parse(content[0].text) as unknown;
}

describe("authenticated knowledge MCP tools", () => {
  const connections: Array<{ client: Client; server: ReturnType<typeof buildMcpServer> }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessibleProject.mockImplementation(async (projectId: string, orgId: string) => (
      projectId === "project-a" && orgId === "org-a"
        ? {
            projectId: "project-a",
            orgId: "org-a",
            name: "Project A",
            slug: "project-a",
            repoUrl: null,
            restricted: false,
            createdBy: "developer-1",
            createdAt: timestamp,
          }
        : null
    ));
    mocks.listKnowledgeBases.mockResolvedValue([base]);
    mocks.createKnowledgeBase.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }));
  });

  async function connect(options: Parameters<typeof buildMcpServer>[1]) {
    const registry = new Registry({ globalRoot: "/nonexistent", localRoot: "/nonexistent" });
    const server = buildMcpServer(registry, options);
    const client = new Client({ name: "knowledge-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  }

  it("does not advertise or execute knowledge tools without complete trusted tenant context", async () => {
    const client = await connect({ defaultUserId: "developer-1" });
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_list");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("knowledge_base_create");
    await expect(client.callTool({
      name: "knowledge_list",
      arguments: { projectId: "project-a", orgId: "org-a", role: "owner" },
    })).rejects.toThrow("Authenticated organization context required");
    expect(mocks.getAccessibleProject).not.toHaveBeenCalled();
  });

  it("lists bases with the session-pinned actor and omits custody identities", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const tools = await client.listTools();
    const result = await client.callTool({
      name: "knowledge_list",
      arguments: { projectId: "project-a", orgId: "org-foreign", userId: "attacker", role: "owner" },
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "knowledge_list",
      "knowledge_base_create",
    ]));
    expect(mocks.getAccessibleProject).toHaveBeenCalledWith(
      "project-a",
      "org-a",
      "developer-1",
      false,
    );
    const payload = parseTextResult(result);
    expect(payload).toEqual({
      bases: [{
        baseId: "kb-1",
        projectId: "project-a",
        name: "Project docs",
        description: "Reviewed project knowledge",
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("developer-1");
    expect(JSON.stringify(payload)).not.toContain("org-a");
  });

  it("creates with server identity and rejects viewer role spoofing", async () => {
    const developer = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const created = await developer.callTool({
      name: "knowledge_base_create",
      arguments: {
        projectId: "project-a",
        name: "Project docs",
        description: "Reviewed project knowledge",
        orgId: "org-foreign",
        userId: "attacker",
        role: "owner",
        isSystemAdmin: true,
      },
    });

    expect(created.isError).not.toBe(true);
    expect(mocks.createKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a",
      projectId: "project-a",
      createdBy: "developer-1",
      name: "Project docs",
    }));

    const viewer = await connect({
      defaultUserId: "viewer-1",
      defaultOrgId: "org-a",
      defaultRole: "viewer",
    });
    const denied = await viewer.callTool({
      name: "knowledge_base_create",
      arguments: { projectId: "project-a", name: "Escalation", role: "owner", isSystemAdmin: true },
    });

    expect(denied.isError).toBe(true);
    expect(parseTextResult(denied)).toEqual({
      error: { code: "forbidden" },
    });
    expect(mocks.createKnowledgeBase).toHaveBeenCalledTimes(1);
  });

  it("returns the same not-found result for inaccessible Projects", async () => {
    const client = await connect({
      defaultUserId: "developer-1",
      defaultOrgId: "org-a",
      defaultRole: "developer",
    });
    const result = await client.callTool({
      name: "knowledge_list",
      arguments: { projectId: "project-foreign" },
    });

    expect(result.isError).toBe(true);
    expect(parseTextResult(result)).toEqual({
      error: { code: "not_found" },
    });
    expect(mocks.listKnowledgeBases).not.toHaveBeenCalled();
  });
});
