/**
 * Task 11 acceptance — org isolation for internal model egress. Two organizations
 * with different model assignments must not observe or use one another's
 * provider/model state: engine.modelRunner() builds an IMMUTABLE per-call runner,
 * and each run() dispatches with its own org's binding through the gateway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelGateway } from "./modelGateway.js";
import type { ProviderModelRecord } from "../../providers/modelPolicyStore.js";

// The DB-provider fallback path resolves through resolveProviderConfig — mock it
// so the "no managed model configured" backward-compat test has a provider to fall
// back to (and returns null in the isolation tests, where a managed model exists).
const { resolveProviderConfigMock } = vi.hoisted(() => ({
  resolveProviderConfigMock: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../../providers/resolver.js", () => ({ resolveProviderConfig: resolveProviderConfigMock }));

const { MemoryEngine } = await import("../../memory/engine.js");

function policy(orgId: string, id: string, isDefault = true): ProviderModelRecord {
  return {
    id: `${orgId}:${id}`,
    orgId,
    providerConfigId: `provider:${orgId}`,
    publicModelId: id,
    upstreamModelId: `private:${id}`,
    displayName: id,
    enabled: true,
    isDefault,
    sortOrder: 0,
    allowedEfforts: ["low", "high"],
    defaultEffort: "low",
    effortWireMap: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } },
    capabilities: { streaming: true, tools: true, responses: true, reasoning: true },
    capabilitySource: "manual",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

/** Minimal engine facade: modelRunner() only reads emailAuth settings + the model store. */
function fakeEngine(models: Record<string, ProviderModelRecord[]>, assigns: Record<string, Record<string, { model?: string }>>) {
  return {
    emailAuth: {
      getSetting: vi.fn(async (key: string) => {
        const orgId = key.replace(/^agentModels:/, "");
        return assigns[orgId] ?? {};
      }),
    },
    models: {
      listProviderModels: vi.fn(async (orgId: string) => models[orgId] ?? []),
      ensureModelGatewayServicePrincipal: vi.fn(async (orgId: string) => `brain-worker:${orgId}`),
    },
    providers: { kind: "fake-provider-store" },
    // modelRunner delegates to the private configureRunner; borrow the real one so
    // `.call(fakeEngine)` resolves it (the method itself only touches models/providers).
    configureRunner: (MemoryEngine.prototype as unknown as Record<string, unknown>).configureRunner,
  } as unknown as MemoryEngine;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resolveProviderConfigMock.mockResolvedValue(null); });

describe("Task 11 — internal egress org isolation", () => {
  const models = {
    "org-a": [policy("org-a", "a-default"), policy("org-a", "a-review", false)],
    "org-b": [policy("org-b", "b-default")],
  };

  it("falls back to the DB provider when the org has NO managed model (no hard failure)", async () => {
    // No provider_models for this org — the pre-Task-11 (ADR-012) direct dispatch.
    resolveProviderConfigMock.mockResolvedValue({ endpoint: "https://byok.example/v1/chat/completions", apiKey: "sk-byok", model: "gpt-x", wireFormat: "chat", source: "db", extra: {} });
    const engine = fakeEngine({}, {});
    const scoped = vi.spyOn(modelGateway, "dispatchScoped").mockResolvedValue("scoped");
    const runner = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-x");
    // Direct dispatch, NOT the gateway — proven by patching global fetch.
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "byok reply" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await runner.run({ prompt: "review this", taskId: "fallback-test" });
    expect(out).toBe("byok reply");
    expect(scoped).not.toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("byok.example");
    vi.unstubAllGlobals();
  });

  it("still throws when NEITHER a managed model NOR a DB provider exists", async () => {
    resolveProviderConfigMock.mockResolvedValue(null);
    const engine = fakeEngine({}, {});
    await expect(MemoryEngine.prototype.modelRunner.call(engine, "synthesis", "org-empty")).rejects.toMatchObject({ code: "model_not_configured" });
  });

  it("modelRunner builds independent runners bound to each org's own assignment", async () => {
    const engine = fakeEngine(models, { "org-a": { "code-review": { model: "a-review" } }, "org-b": {} });
    const dispatched: Array<{ orgId: string; model: string; servicePrincipalId: string }> = [];
    vi.spyOn(modelGateway, "dispatchScoped").mockImplementation(async (opts) => {
      dispatched.push({ orgId: opts.orgId, model: opts.model, servicePrincipalId: opts.servicePrincipalId });
      return "ok";
    });

    const runnerA = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-a");
    const runnerB = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-b");
    expect(runnerA).not.toBe(runnerB);

    await runnerA.run({ prompt: "p", taskId: "isolation-a" });
    await runnerB.run({ prompt: "p", taskId: "isolation-b" });

    // Each org dispatched with ITS OWN model + principal — no cross-observation.
    expect(dispatched).toEqual([
      { orgId: "org-a", model: "a-review", servicePrincipalId: "brain-worker:org-a" },
      { orgId: "org-b", model: "b-default", servicePrincipalId: "brain-worker:org-b" },
    ]);
  });

  it("an org cannot select another org's model via its assignment", async () => {
    // org-b's admin assignment names org-a's model — the scoped selection must not
    // leak it; it falls back to org-b's own default policy instead.
    const engine = fakeEngine(models, { "org-b": { "code-review": { model: "a-review" } } });
    const dispatched: string[] = [];
    vi.spyOn(modelGateway, "dispatchScoped").mockImplementation(async (opts) => {
      dispatched.push(`${opts.orgId}:${opts.model}`);
      return "ok";
    });
    const runner = await MemoryEngine.prototype.modelRunner.call(engine, "code-review", "org-b");
    await runner.run({ prompt: "p", taskId: "isolation-leak" });
    expect(dispatched).toEqual(["org-b:b-default"]);
  });

  it("concurrent runs from two orgs never blend bindings (no process-global state)", async () => {
    const engine = fakeEngine(models, {});
    const seen: string[] = [];
    vi.spyOn(modelGateway, "dispatchScoped").mockImplementation(async (opts) => {
      await new Promise((r) => setTimeout(r, opts.orgId === "org-a" ? 20 : 1));
      seen.push(`${opts.orgId}:${opts.model}`);
      return "ok";
    });
    const [runnerA, runnerB] = await Promise.all([
      MemoryEngine.prototype.modelRunner.call(engine, "synthesis", "org-a"),
      MemoryEngine.prototype.modelRunner.call(engine, "synthesis", "org-b"),
    ]);
    await Promise.all([
      runnerA.run({ prompt: "p", taskId: "t-a" }),
      runnerB.run({ prompt: "p", taskId: "t-b" }),
    ]);
    expect(seen.sort()).toEqual(["org-a:a-default", "org-b:b-default"]);
  });
});
