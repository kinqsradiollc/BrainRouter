/**
 * B3 profile recommendation transport coverage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "../registry.js";
import { buildMcpServer } from "./mcpServer.js";

function parseTextResult(result: unknown) {
  const content = (result as { content?: unknown })?.content as Array<{ text?: unknown }>;
  if (typeof content[0]?.text !== "string") throw new Error("Expected a text tool result");
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("workspace profile recommendation MCP tool", () => {
  const connections: Array<{ client: Client; server: ReturnType<typeof buildMcpServer> }> = [];

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }));
  });

  async function connect() {
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const repositoryRoot = path.resolve(packageRoot, "..");
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brainrouter-profile-recommend-"));
    const registry = new Registry({ globalRoot: repositoryRoot, localRoot });
    registry.build();
    const server = buildMcpServer(registry);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "profile-recommend-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    connections.push({ client, server });
    return { client, localRoot, repositoryRoot };
  }

  it("advertises and serves an availability-filtered advisory recommendation without auth", async () => {
    const { client, localRoot, repositoryRoot } = await connect();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("workspace_profile_recommend");

      const result = await client.callTool({
        name: "workspace_profile_recommend",
        arguments: { profile: "research" },
      });
      expect(result.isError).not.toBe(true);
      const payload = parseTextResult(result);
      expect(payload).toMatchObject({
        profile: { id: "research", label: "Research" },
        advisory: true,
        authorizationEffect: "none",
        complete: true,
        agents: { default: "researcher", enabled: ["researcher"] },
        skillPacks: [{
          id: "research",
          source: "profile-plugin",
          version: "2.4.0",
          skillIds: [
            "research-question-skill",
            "source-strategy-skill",
            "iterative-evidence-skill",
            "evidence-research-skill",
            "claim-ledger-skill",
            "source-synthesis-skill",
            "citation-verification-skill",
            "research-review-skill",
            "academic-paper-drafting-skill",
            "academic-paper-review-skill",
          ],
        }],
      });
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(repositoryRoot);
      expect(serialized).not.toContain(localRoot);
      expect(serialized).not.toContain("pluginRoot");
      expect(serialized).not.toContain("filePath");
      expect(serialized).not.toContain("orgId");
      expect(serialized).not.toContain("userId");
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it("rejects unknown profiles at the closed transport schema", async () => {
    const { client, localRoot } = await connect();
    try {
      await expect(client.callTool({
        name: "workspace_profile_recommend",
        arguments: { profile: "administrator", orgId: "org-foreign" },
      })).rejects.toThrow("Invalid arguments");
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
