import { describe, it, expect } from "vitest";
import {
  mapCodeqlSarifToSourceToSinkPaths,
  type CodeqlSarif,
} from "./codeqlSarifMapping.js";

const flowLoc = (uri: string, startLine: number) => ({
  location: { physicalLocation: { artifactLocation: { uri }, region: { startLine } } },
});
const resultWithFlow = (
  ruleId: string,
  locs: { uri: string; line: number }[],
) => ({
  ruleId,
  codeFlows: [{ threadFlows: [{ locations: locs.map((l) => flowLoc(l.uri, l.line)) }] }],
});

describe("mapCodeqlSarifToSourceToSinkPaths", () => {
  it("maps a codeFlow to a source→sink path (first location = source, last = sink)", () => {
    const sarif: CodeqlSarif = {
      runs: [
        {
          results: [
            resultWithFlow("js/polynomial-redos", [
              { uri: "a/orgs.ts", line: 33 },
              { uri: "a/orgs.ts", line: 38 },
              { uri: "a/orgs.ts", line: 44 },
            ]),
          ],
        },
      ],
    };
    const paths = mapCodeqlSarifToSourceToSinkPaths(sarif);
    expect(paths).toHaveLength(1);
    expect(paths[0].mechanism).toBe("data_flow");
    expect(paths[0].source).toEqual({ path: "a/orgs.ts", line: 33 });
    expect(paths[0].sink).toEqual({ path: "a/orgs.ts", line: 44 });
    expect(paths[0].id).toContain("js/polynomial-redos");
    expect(paths[0].evidenceRefs).toEqual([]);
  });

  it("ADR-039 D6 (S4) — carries the ORDERED intermediate hops, not just source+sink", () => {
    const sarif: CodeqlSarif = {
      runs: [{ results: [resultWithFlow("js/request-forgery", [
        { uri: "req.ts", line: 10 },   // source (attacker-controlled body)
        { uri: "handler.ts", line: 22 }, // hop
        { uri: "net/fetch.ts", line: 4 }, // sink
      ])] }],
    };
    const [path] = mapCodeqlSarifToSourceToSinkPaths(sarif);
    expect(path.hops).toEqual([
      { path: "req.ts", line: 10 },
      { path: "handler.ts", line: 22 },
      { path: "net/fetch.ts", line: 4 },
    ]);
    // source/sink stay the first/last hop for back-compat.
    expect(path.source).toEqual(path.hops![0]);
    expect(path.sink).toEqual(path.hops![path.hops!.length - 1]);
  });

  it("skips results without a codeFlow (point findings, not taint paths)", () => {
    const sarif: CodeqlSarif = {
      runs: [
        {
          results: [
            { ruleId: "js/point-finding" },
            resultWithFlow("js/taint", [
              { uri: "x.ts", line: 1 },
              { uri: "y.ts", line: 2 },
            ]),
          ],
        },
      ],
    };
    const paths = mapCodeqlSarifToSourceToSinkPaths(sarif);
    expect(paths).toHaveLength(1);
    expect(paths[0].source.path).toBe("x.ts");
    expect(paths[0].sink.path).toBe("y.ts");
  });

  it("skips a single-location flow (needs ≥2 for a source→sink edge)", () => {
    const sarif: CodeqlSarif = {
      runs: [{ results: [resultWithFlow("js/one", [{ uri: "z.ts", line: 5 }])] }],
    };
    expect(mapCodeqlSarifToSourceToSinkPaths(sarif)).toHaveLength(0);
  });

  it("gives each path a distinct id across results", () => {
    const sarif: CodeqlSarif = {
      runs: [
        {
          results: [
            resultWithFlow("js/a", [{ uri: "1.ts", line: 1 }, { uri: "1.ts", line: 2 }]),
            resultWithFlow("js/a", [{ uri: "2.ts", line: 1 }, { uri: "2.ts", line: 2 }]),
          ],
        },
      ],
    };
    const paths = mapCodeqlSarifToSourceToSinkPaths(sarif);
    expect(new Set(paths.map((p) => p.id)).size).toBe(2);
  });

  it("tolerates empty/missing runs and results", () => {
    expect(mapCodeqlSarifToSourceToSinkPaths({})).toEqual([]);
    expect(mapCodeqlSarifToSourceToSinkPaths({ runs: [] })).toEqual([]);
    expect(mapCodeqlSarifToSourceToSinkPaths({ runs: [{}] })).toEqual([]);
  });
});
