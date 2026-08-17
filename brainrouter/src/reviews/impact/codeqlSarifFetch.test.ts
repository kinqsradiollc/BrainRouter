import { describe, it, expect, vi } from "vitest";
import {
  fetchCodeqlSourceToSinkPaths,
  selectAnalysisId,
  type SarifFetchImpl,
  type SarifFetchResponse,
} from "./codeqlSarifFetch.js";

const ok = (body: unknown): SarifFetchResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const notOk = (status: number): SarifFetchResponse => ({
  ok: false,
  status,
  json: async () => ({}),
});

const sarifWithOnePath = {
  runs: [
    {
      results: [
        {
          ruleId: "js/request-forgery",
          codeFlows: [
            {
              threadFlows: [
                {
                  locations: [
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: "a.ts" },
                          region: { startLine: 3 },
                        },
                      },
                    },
                    {
                      location: {
                        physicalLocation: {
                          artifactLocation: { uri: "b.ts" },
                          region: { startLine: 9 },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("selectAnalysisId", () => {
  it("returns the first (newest) analysis whose category names the language", () => {
    const analyses = [
      { id: 30, category: "/language:python" },
      { id: 29, category: "/language:javascript-typescript" },
      { id: 28, category: "/language:javascript-typescript" },
    ];
    expect(selectAnalysisId(analyses, "javascript")).toBe(29);
  });
  it("returns null when nothing matches", () => {
    expect(selectAnalysisId([{ id: 1, category: "/language:python" }], "javascript")).toBeNull();
  });
});

describe("fetchCodeqlSourceToSinkPaths", () => {
  it("lists analyses, fetches the SARIF with the sarif accept header, and maps paths", async () => {
    const calls: { url: string; accept: string }[] = [];
    const fetchImpl: SarifFetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, accept: init.headers.Accept });
      if (url.includes("/code-scanning/analyses?"))
        return ok([{ id: 29, category: "/language:javascript-typescript" }]);
      if (url.endsWith("/code-scanning/analyses/29")) return ok(sarifWithOnePath);
      throw new Error(`unexpected url ${url}`);
    });

    const paths = await fetchCodeqlSourceToSinkPaths({
      apiBase: "https://api.github.com",
      repo: "o/r",
      ref: "refs/heads/main",
      token: "t",
      fetchImpl,
    });

    expect(paths).toHaveLength(1);
    expect(paths[0].source.path).toBe("a.ts");
    expect(paths[0].sink.path).toBe("b.ts");
    // the analyses list uses the JSON accept; the SARIF fetch uses the sarif accept.
    expect(calls[0].url).toContain("/code-scanning/analyses?ref=refs%2Fheads%2Fmain");
    expect(calls[1].url).toContain("/code-scanning/analyses/29");
    expect(calls[1].accept).toBe("application/sarif+json");
  });

  it("returns [] when the analyses list is non-2xx (code scanning unavailable)", async () => {
    const fetchImpl: SarifFetchImpl = async () => notOk(404);
    expect(
      await fetchCodeqlSourceToSinkPaths({
        apiBase: "https://api.github.com",
        repo: "o/r",
        ref: "sha",
        token: "t",
        fetchImpl,
      }),
    ).toEqual([]);
  });

  it("returns [] when no analysis matches the language", async () => {
    const fetchImpl: SarifFetchImpl = async () => ok([{ id: 5, category: "/language:python" }]);
    expect(
      await fetchCodeqlSourceToSinkPaths({
        apiBase: "https://api.github.com",
        repo: "o/r",
        ref: "sha",
        token: "t",
        fetchImpl,
      }),
    ).toEqual([]);
  });

  it("returns [] when the SARIF fetch is non-2xx", async () => {
    const fetchImpl: SarifFetchImpl = async (url) =>
      url.includes("analyses?")
        ? ok([{ id: 7, category: "/language:javascript-typescript" }])
        : notOk(500);
    expect(
      await fetchCodeqlSourceToSinkPaths({
        apiBase: "https://api.github.com",
        repo: "o/r",
        ref: "sha",
        token: "t",
        fetchImpl,
      }),
    ).toEqual([]);
  });
});
