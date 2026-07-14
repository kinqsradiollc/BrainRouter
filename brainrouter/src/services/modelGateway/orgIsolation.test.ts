/**
 * Task 11 acceptance — org isolation for internal model egress. Two organizations
 * with different model assignments must not observe or use one another's
 * provider/model state: engine.modelRunner() builds an IMMUTABLE per-call runner,
 * and each run() dispatches with its own org's binding through the gateway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryEngine } from "../../memory/engine.js";
import { modelGateway } from "./modelGateway.js";
import type { ProviderModelRecord } from "../../providers/modelPolicyStore.js";

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
  } as unknown as MemoryEngine;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Task 11 — internal egress org isolation", () => {
  const models = {
    "org-a": [policy("org-a", "a-default"), policy("org-a", "a-review", false)],
    "org-b": [policy("org-b", "b-default")],
  };

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
