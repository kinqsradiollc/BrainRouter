/**
 * ADR-033 D2 — the code graph decides which changed files share a review unit,
 * and it can only ever join files the change already contains.
 */
import { describe, expect, it } from "vitest";
import type {
  AssuranceCodeRelationshipEdge,
  AssuranceCodeSymbol,
} from "@kinqs/brainrouter-types/review";
import {
  MAX_RELATED_PATH_EDGES,
  relatedChangedPathsFromGraph,
} from "./relatedChangedPaths.js";

function symbol(id: string, path: string): AssuranceCodeSymbol {
  return {
    id,
    name: id,
    kind: "function",
    language: "typescript",
    location: { path, line: 1 },
    exported: true,
  };
}

function edge(id: string, from: string, to: string): AssuranceCodeRelationshipEdge {
  return { id, relationship: "calls", fromSymbolId: from, toSymbolId: to };
}

describe("related changed paths", () => {
  it("joins a route to the handler it calls, even when neither hunk shows an import", () => {
    const edges = relatedChangedPathsFromGraph(
      {
        symbols: [symbol("route", "src/api/orders.ts"), symbol("handler", "src/orders/handler.ts")],
        relationships: [edge("e1", "route", "handler")],
      },
      ["src/api/orders.ts", "src/orders/handler.ts"],
    );
    expect(edges).toEqual([["src/api/orders.ts", "src/orders/handler.ts"]]);
  });

  it("cannot widen the review: an edge that leaves the changeset is dropped", () => {
    const edges = relatedChangedPathsFromGraph(
      {
        symbols: [symbol("changed", "src/a.ts"), symbol("untouched", "src/vendor/huge.ts")],
        relationships: [edge("e1", "changed", "untouched")],
      },
      ["src/a.ts"],
    );
    expect(edges).toEqual([]);
  });

  it("uses exact path relationships only when both generated/source endpoints changed", () => {
    const graph = {
      symbols: [],
      relationships: [],
      pathRelationships: [
        ["electron/host.ts", "dist-electron/host.js"],
        ["electron/untouched.ts", "dist-electron/other.js"],
      ] as Array<[string, string]>,
    };
    expect(relatedChangedPathsFromGraph(graph, ["electron/host.ts", "dist-electron/host.js"])).toEqual([
      ["dist-electron/host.js", "electron/host.ts"],
    ]);
    expect(relatedChangedPathsFromGraph(graph, ["electron/host.ts"])).toEqual([]);
  });

  it("reports one edge per pair regardless of how many symbols connect them", () => {
    const edges = relatedChangedPathsFromGraph(
      {
        symbols: [
          symbol("a1", "src/a.ts"),
          symbol("a2", "src/a.ts"),
          symbol("b1", "src/b.ts"),
        ],
        relationships: [edge("e1", "a1", "b1"), edge("e2", "a2", "b1"), edge("e3", "b1", "a1")],
      },
      ["src/a.ts", "src/b.ts"],
    );
    expect(edges).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("ignores an edge inside one file, and a change too small to have relations", () => {
    expect(
      relatedChangedPathsFromGraph(
        { symbols: [symbol("a", "src/a.ts"), symbol("b", "src/a.ts")], relationships: [edge("e", "a", "b")] },
        ["src/a.ts"],
      ),
    ).toEqual([]);
    expect(relatedChangedPathsFromGraph({ symbols: [], relationships: [] }, ["src/a.ts"])).toEqual([]);
  });

  it("stops at the edge ceiling so one barrel file cannot union the whole change", () => {
    const paths = Array.from({ length: 200 }, (_, index) => `src/f${index}.ts`);
    const symbols = paths.map((path, index) => symbol(`s${index}`, path));
    const relationships: AssuranceCodeRelationshipEdge[] = [];
    for (let from = 0; from < symbols.length; from++) {
      for (let to = from + 1; to < symbols.length; to++) {
        relationships.push(edge(`e${from}-${to}`, `s${from}`, `s${to}`));
      }
    }
    const edges = relatedChangedPathsFromGraph({ symbols, relationships }, paths);
    expect(edges.length).toBe(MAX_RELATED_PATH_EDGES);
  });
});
