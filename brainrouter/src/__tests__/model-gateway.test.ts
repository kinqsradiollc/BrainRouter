import { describe, expect, it, vi, afterEach } from "vitest";
import { modelGateway } from "../services/modelGateway/modelGateway.js";

// ADR-039 — the memory-pipeline dispatch now validates the target through the
// upstream policy (DNS resolve). Mock DNS so fake test hosts resolve to a PUBLIC IP
// (policy admits public, refuses internal — see policyFetch.test.ts).
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));


function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["llm", "embedding", "reranker"] as const) modelGateway.configure(k, null);
});

describe("MODEL-GATEWAY — the single gateway all model providers route through", () => {
  it("snapshot() reports which kinds are registered", () => {
    expect(modelGateway.snapshot()).toEqual({ llm: false, embedding: false, reranker: false });
    modelGateway.configure("llm", { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    modelGateway.configure("embedding", { endpoint: "https://api.openai.com/v1" });
    expect(modelGateway.snapshot()).toEqual({ llm: true, embedding: true, reranker: false });
    expect(modelGateway.isConfigured("llm")).toBe(true);
  });

  it("dispatch() routes a chat-completions call and returns the content", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { seen.push(url); return mockResponse({ choices: [{ message: { content: "hello" } }] }); }));
    const out = await modelGateway.dispatch({ endpoint: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("hello");
    expect(seen[0]).toBe("https://api.openai.com/v1/chat/completions"); // base URL cause resolved
  });

  it("dispatch() returns the tool-call arguments when a tool is forced (structured output)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"x":1}' } }] } }] })));
    const out = await modelGateway.dispatch({
      endpoint: "https://api.openai.com/v1", apiKey: "k", model: "m",
      messages: [{ role: "user", content: "hi" }], tool: { name: "emit", parameters: {} },
    });
    expect(out).toBe('{"x":1}');
  });

  it("dispatch() speaks the Responses wire when configured (posts /responses, reads output_text)", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { seen.push(url); return mockResponse({ output_text: "resp!" }); }));
    const out = await modelGateway.dispatch({ endpoint: "https://api.openai.com/v1", apiKey: "k", model: "m", wireFormat: "responses", messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("resp!");
    expect(seen[0]).toBe("https://api.openai.com/v1/responses");
  });

  it("chat(kind) resolves the registered provider + dispatches through the gateway", async () => {
    modelGateway.configure("llm", { endpoint: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini" });
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ choices: [{ message: { content: "yes" } }] })));
    const out = await modelGateway.chat("llm", { messages: [{ role: "user", content: "relevant?" }] });
    expect(out).toBe("yes");
  });

  it("chat(kind) throws LLM_NOT_CONFIGURED when the kind has no provider", async () => {
    await expect(modelGateway.chat("llm", { messages: [] })).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
  });
});
