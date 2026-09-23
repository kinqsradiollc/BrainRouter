/**
 * The roots handshake, for real: an actual MCP client that declares `roots`,
 * connected to the actual brain server. `roots/list` is a request from the
 * SERVER to the client made while the server is handling the client's own
 * tool call — the part a unit test of the helper cannot prove works.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";

const mocks = vi.hoisted(() => ({ recall: vi.fn(), searchAsOf: vi.fn(), spikeSkill: vi.fn() }));
vi.mock("../memory/engine.js", () => ({
  memoryEngine: { recall: mocks.recall, searchAsOf: mocks.searchAsOf, spikeSkill: mocks.spikeSkill },
}));

import { Registry } from "../registry.js";
import { buildMcpServer } from "./mcpServer.js";

const PROJECT = "/Users/someone/code/widget";
const HERE = workspaceTagFromPath(PROJECT)!;
const connections: Array<{ client: Client; close: () => Promise<void> }> = [];

async function connect(opts: { roots: boolean; rootsFor?: () => string[] }) {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "br-client-roots-"));
  const registry = new Registry({ globalRoot: localRoot, localRoot });
  registry.build();
  const server = buildMcpServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "another-coding-agent", version: "1.0.0" },
    { capabilities: opts.roots ? { roots: { listChanged: true } } : {} },
  );
  const asked = { count: 0 };
  if (opts.roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      asked.count += 1;
      return { roots: (opts.rootsFor?.() ?? [PROJECT]).map((p) => ({ uri: pathToFileURL(p).href })) };
    });
  }
  await client.connect(clientTransport);
  connections.push({
    client,
    close: async () => {
      await client.close();
      fs.rmSync(localRoot, { recursive: true, force: true });
    },
  });
  return { client, asked };
}

const scopeOfLastRecall = () => mocks.recall.mock.calls.at(-1)?.[0]?.preferScope;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recall.mockResolvedValue({ recallStrategy: "hybrid", recalledCognitiveMemories: [] });
});
afterEach(async () => {
  while (connections.length) await connections.pop()!.close();
});

describe("another agent's memory search, scoped by its declared roots", () => {
  it("asks the client where it is and ranks that workspace first", async () => {
    const { client, asked } = await connect({ roots: true });
    const result = await client.callTool({ name: "memory_search", arguments: { query: "ledger" } });
    expect(result.isError).toBeFalsy();
    expect(asked.count).toBe(1);
    expect(scopeOfLastRecall()?.workspaceTags).toEqual([HERE]);
  });

  it("asks once per connection, not once per search", async () => {
    const { client, asked } = await connect({ roots: true });
    await client.callTool({ name: "memory_search", arguments: { query: "a" } });
    await client.callTool({ name: "memory_search", arguments: { query: "b" } });
    await client.callTool({ name: "memory_recall", arguments: { query: "c", sessionKey: "s" } });
    expect(asked.count).toBe(1);
    expect(scopeOfLastRecall()?.workspaceTags).toEqual([HERE]);
  });

  it("asks again when the client says its roots changed", async () => {
    let folder = PROJECT;
    const { client, asked } = await connect({ roots: true, rootsFor: () => [folder] });
    await client.callTool({ name: "memory_search", arguments: { query: "a" } });
    folder = "/Users/someone/code/other";
    await client.sendRootsListChanged();
    // The notification is delivered asynchronously; give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.callTool({ name: "memory_search", arguments: { query: "b" } });
    expect(asked.count).toBe(2);
    expect(scopeOfLastRecall()?.workspaceTags).toEqual([workspaceTagFromPath(folder)]);
  });

  it("never asks a client that did not declare roots, and still answers it", async () => {
    const { client } = await connect({ roots: false });
    const result = await client.callTool({ name: "memory_search", arguments: { query: "ledger" } });
    expect(result.isError).toBeFalsy();
    expect(scopeOfLastRecall()?.workspaceTags).toBeUndefined();
  });

  it("a caller that brings its own scope keeps it", async () => {
    const { client, asked } = await connect({ roots: true });
    await client.callTool({
      name: "memory_search",
      arguments: { query: "ledger", workspaceTags: ["folder_tag_0000", "repo_tag_00000"] },
    });
    expect(asked.count).toBe(0);
    expect(scopeOfLastRecall()?.workspaceTags).toEqual(["folder_tag_0000", "repo_tag_00000"]);
  });
});
