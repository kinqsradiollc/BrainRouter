/**
 * Internal sub-agent egress — org isolation WITHOUT server-managed models.
 *
 * Product decision: server-managed models exist only for BrainRouter to act as a
 * model *provider* to the desktop app. Internal sub-agents (extraction, synthesis,
 * reviews, meeting summaries) must run off each org's OWN provider (BYOK /
 * personal, ADR-012) plus its per-role model override (ADR-014) — never a managed
 * model, and never the scoped gateway. Two organizations must not observe or use
 * one another's provider/model state, and an org with no managed model (or none at
 * all) must NOT hard-fail with "no managed model is configured".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelGateway } from "./modelGateway.js";

// configureRunner resolves the org provider through resolveProviderConfig — mock it
// so each test controls exactly which provider (if any) each org resolves to.
// vi.mock is hoisted above these imports, so the static MemoryEngine import below
// already sees the mocked resolver.
const { resolveProviderConfigMock } = vi.hoisted(() => ({
  resolveProviderConfigMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));
vi.mock("../../providers/resolver.js", () => ({ resolveProviderConfig: resolveProviderConfigMock }));

// ADR-039 — the memory-pipeline dispatch now validates the target through the
// upstream policy (DNS resolve). Mock DNS so fake test hosts resolve to a PUBLIC IP
// (policy admits public, refuses internal — see policyFetch.test.ts).
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));


import { MemoryEngine } from "../../memory/engine.js";

/** Minimal engine facade: modelRunner() only reads emailAuth settings; configureRunner reads providers. */
function fakeEngine(assigns: Record<string, Record<string, { model?: string }>>) {
  return {
    emailAuth: {
      getSetting: vi.fn(async (key: string) => {
        const orgId = key.replace(/^agentModels:/, "");
        return assigns[orgId] ?? {};
      }),
    },
    providers: { kind: "fake-provider-store" },
    // modelRunner delegates to the private configureRunner; borrow the real one so
    // `.call(fakeEngine)` resolves it (it only touches providers via the mock).
    configureRunner: (MemoryEngine.prototype as unknown as Record<string, unknown>).configureRunner,
  } as unknown as MemoryEngine;
}

/** A stub upstream that echoes the request so tests can inspect endpoint + model. */
function stubFetch() {
  const calls: Array<{ url: string; model: string }> = [];
  const spy = vi.fn(async (url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
    calls.push({ url: String(url), model: String(body.model) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "reply" } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resolveProviderConfigMock.mockResolvedValue(null); });

describe("internal sub-agent egress — org isolation without managed models", () => {
  it("runs a sub-agent off the org's OWN provider, never the scoped/managed gateway", async () => {
    resolveProviderConfigMock.mockResolvedValue({ endpoint: "https://byok.example/v1/chat/completions", apiKey: "sk-byok", model: "gpt-x", wireFormat: "chat", source: "db", extra: {} });
    const scoped = vi.spyOn(modelGateway, "dispatchScoped").mockResolvedValue("scoped");
    const runner = await MemoryEngine.prototype.modelRunner.call(fakeEngine({}), "code-review", "org-x");
    const { calls } = stubFetch();
    const out = await runner.run({ prompt: "review this", taskId: "byok" });
    expect(out).toBe("reply");
    expect(scoped).not.toHaveBeenCalled(); // managed-model gateway never touched
    expect(calls[0]?.url).toContain("byok.example");
  });

  it("never hard-fails with 'no managed model' — an unconfigured org skips cognition cleanly", async () => {
    resolveProviderConfigMock.mockResolvedValue(null); // no managed model AND no provider
    const runner = await MemoryEngine.prototype.modelRunner.call(fakeEngine({}), "synthesis", "org-empty");
    await expect(runner.run({ prompt: "p", taskId: "unconfigured" })).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
  });

  it("isolates orgs — each resolves and dispatches to its OWN provider", async () => {
    resolveProviderConfigMock.mockImplementation(async (...args: unknown[]) => (
      args[1] === "org-a"
        ? { endpoint: "https://a.example/v1/chat/completions", apiKey: "sk-a", model: "model-a", wireFormat: "chat", source: "db", extra: {} }
        : { endpoint: "https://b.example/v1/chat/completions", apiKey: "sk-b", model: "model-b", wireFormat: "chat", source: "db", extra: {} }
    ));
    const engine = fakeEngine({});
    const runnerA = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-a");
    const runnerB = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-b");
    expect(runnerA).not.toBe(runnerB);
    const { calls } = stubFetch();
    await runnerA.run({ prompt: "p", taskId: "iso-a" });
    await runnerB.run({ prompt: "p", taskId: "iso-b" });
    expect(calls).toEqual([
      { url: "https://a.example/v1/chat/completions", model: "model-a" },
      { url: "https://b.example/v1/chat/completions", model: "model-b" },
    ]);
  });

  it("applies the org's per-role model override on top of its own provider", async () => {
    resolveProviderConfigMock.mockResolvedValue({ endpoint: "https://a.example/v1/chat/completions", apiKey: "sk-a", model: "provider-default", wireFormat: "chat", source: "db", extra: {} });
    const engine = fakeEngine({ "org-a": { "code-review": { model: "pinned-review-model" } } });
    const runner = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-a");
    const { calls } = stubFetch();
    await runner.run({ prompt: "p", taskId: "override" });
    expect(calls[0]?.model).toBe("pinned-review-model");
  });
});
