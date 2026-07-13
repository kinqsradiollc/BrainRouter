import { describe, expect, it, vi } from "vitest";
import type { ConnectorDocumentRecord, SourceChunk, SourceDocument } from "@kinqs/brainrouter-types";
import { connectorDocumentToMemoryRecord, connectorMemoryId } from "@kinqs/brainrouter-core/connectors";
import { connectorRecordIdsByDocument, ingestConnectorSources } from "./knowledgeImport.js";

const document: ConnectorDocumentRecord = {
  id: "github:org/repo:issue:7",
  connectorId: "runtime-connector-1",
  source: "github",
  kind: "issue",
  repository: "org/repo",
  title: "Scoped issue",
  url: "https://github.example/org/repo/issues/7",
  updatedAt: "2026-07-13T00:00:00.000Z",
  text: "A connector document with enough detail to become a durable source chunk for scoped recall and citation.",
  metadata: { number: 7 },
  firstSeenAt: "2026-07-13T00:00:00.000Z",
  lastSeenAt: "2026-07-13T00:00:00.000Z",
};

describe("connector source import", () => {
  it("matches the cognitive ids produced by import chunking", () => {
    const longDocument = { ...document, text: "Scoped connector knowledge. ".repeat(20) };
    const memory = connectorDocumentToMemoryRecord(longDocument, {
      userId: "user-1",
      orgId: "org-1",
      visibility: "org",
      workspaceTag: null,
    });

    const ids = connectorRecordIdsByDocument([memory], 120).get(document.id) ?? [];

    expect(ids.length).toBeGreaterThan(1);
    expect(ids[0]).toBe(`${connectorMemoryId(document.id)}::c0`);
    expect(ids.at(-1)).toMatch(/::c\d+$/);
  });

  it("persists connector documents in the explicit tenant scope and links their cognitive record", async () => {
    let createdInput: any;
    const source: SourceDocument = {
      id: "source-1",
      userId: "user-1",
      orgId: "org-1",
      projectId: null,
      workspaceTag: null,
      kind: "imported_doc",
      uri: document.url ?? null,
      hash: "hash",
      title: document.title,
      createdAt: "2026-07-13T00:00:00.000Z",
      metadata: {},
    };
    const chunk: SourceChunk = {
      id: "chunk-1",
      documentId: source.id,
      ordinal: 0,
      content: document.text,
      tokenCount: 20,
      filePath: null,
      symbol: null,
      startLine: null,
      endLine: null,
      hash: "chunk-hash",
    };
    const store = {
      createSourceDocument: vi.fn(async (input: any) => {
        createdInput = input;
        return { ...source, ...input };
      }),
      getSourceChunksByDocument: vi.fn(async () => []),
      addSourceChunks: vi.fn(async () => [chunk]),
      linkRecordSources: vi.fn(async () => {}),
    };

    const parentId = connectorMemoryId(document.id);
    const result = await ingestConnectorSources(
      store,
      [document],
      {
        connectorId: "db-connector-1",
        userId: "user-1",
        orgId: "org-1",
        visibility: "org",
        projectId: null,
        workspaceTag: null,
      },
      new Map([[document.id, [`${parentId}::c0`, `${parentId}::c1`]]]),
    );

    expect(result).toEqual({ documents: 1, chunks: 1, links: 2 });
    expect(createdInput).toMatchObject({
      userId: "user-1",
      orgId: "org-1",
      projectId: null,
      workspaceTag: null,
      kind: "imported_doc",
      uri: document.url,
      title: "Scoped issue",
      metadata: {
        connectorId: "db-connector-1",
        connectorDocumentId: document.id,
        connectorSource: "github",
        connectorKind: "issue",
        visibility: "org",
      },
    });
    expect(store.linkRecordSources).toHaveBeenNthCalledWith(1, "user-1", `${parentId}::c0`, ["chunk-1"]);
    expect(store.linkRecordSources).toHaveBeenNthCalledWith(2, "user-1", `${parentId}::c1`, ["chunk-1"]);
  });
});
