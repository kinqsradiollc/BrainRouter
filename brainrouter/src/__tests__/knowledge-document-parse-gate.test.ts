/**
 * ADR-030 Q3 + ADR-027 D12 — the hosted parse is admitted, and refusal is a
 * different answer from rejection.
 */
import { describe, expect, it } from "vitest";
import { DocumentParseGate } from "../knowledge/services/documentParseGate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("DocumentParseGate", () => {
  it("runs one parse at a time — the wasm call cannot be preempted, so it is not overlapped", async () => {
    const gate = new DocumentParseGate();
    let concurrent = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
    };

    await Promise.all([1, 2, 3, 4].map(() => gate.run("org-1", work)));
    expect(peak).toBe(1);
    expect(gate.depth).toEqual({ active: 0, waiting: 0 });
  });

  it("refuses past the queue bound rather than letting callers pile up", async () => {
    const gate = new DocumentParseGate({ maxWaiting: 2, maxWaitingPerTenant: 99 });
    const held = deferred();

    // One active plus two waiting fills it; the fourth is refused immediately.
    const running = [
      gate.run("org-1", () => held.promise),
      gate.run("org-1", () => held.promise),
      gate.run("org-1", () => held.promise),
    ];
    const refused = await gate.run("org-1", async () => "never");
    expect(refused.admitted).toBe(false);

    held.resolve();
    await Promise.all(running);
    // And the gate recovers: once the queue drains, the next caller is admitted.
    const after = await gate.run("org-1", async () => "ok");
    expect(after).toEqual({ admitted: true, value: "ok" });
  });

  it("bounds ONE tenant's share, so a bulk import cannot refuse everyone else", async () => {
    const gate = new DocumentParseGate({ maxWaiting: 16, maxWaitingPerTenant: 2 });
    const held = deferred();

    const bulk = [
      gate.run("org-noisy", () => held.promise),
      gate.run("org-noisy", () => held.promise),
    ];
    const alsoNoisy = await gate.run("org-noisy", async () => "never");
    expect(alsoNoisy.admitted).toBe(false);

    // The other tenant is admitted even while the first is at its own limit.
    const neighbour = gate.run("org-quiet", async () => "mine");
    held.resolve();
    await Promise.all(bulk);
    expect(await neighbour).toEqual({ admitted: true, value: "mine" });
  });

  it("a parse that throws releases its slot instead of wedging the queue", async () => {
    const gate = new DocumentParseGate({ maxWaiting: 2, maxWaitingPerTenant: 2 });
    await expect(gate.run("org-1", async () => { throw new Error("hostile file"); }))
      .rejects.toThrow("hostile file");
    expect(gate.depth).toEqual({ active: 0, waiting: 0 });
    expect(await gate.run("org-1", async () => "next")).toEqual({ admitted: true, value: "next" });
  });
});
