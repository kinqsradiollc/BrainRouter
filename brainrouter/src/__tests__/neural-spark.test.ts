import { describe, expect, it } from "vitest";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import { NeuralSparkEngine } from "../memory/pipeline/neural-spark.js";

class MockMemoryStore implements Partial<IMemoryStore> {
  public connections: Array<{ sourceId: string; targetId: string; weight: number; lastActivatedAt: string }> = [];
  public memories = new Map<string, any>();

  public upsertConnection(userId: string, sourceId: string, targetId: string, weight: number): void {
    const existing = this.connections.find(c => c.sourceId === sourceId && c.targetId === targetId);
    if (existing) {
      existing.weight = weight;
      existing.lastActivatedAt = new Date().toISOString();
    } else {
      this.connections.push({ sourceId, targetId, weight, lastActivatedAt: new Date().toISOString() });
    }
  }

  public getConnectionsForSource(userId: string, sourceId: string): Array<{ targetId: string; weight: number }> {
    return this.connections
      .filter(c => c.sourceId === sourceId)
      .map(c => ({ targetId: c.targetId, weight: c.weight }));
  }

  public strengthenConnectionsBatch(userId: string, pairs: Array<{ source: string; target: string }>, delta: number): void {
    for (const pair of pairs) {
      // Bi-directional
      this.upsertConnection(userId, pair.source, pair.target, Math.min(1.0, this.getWeight(pair.source, pair.target) + delta));
      this.upsertConnection(userId, pair.target, pair.source, Math.min(1.0, this.getWeight(pair.target, pair.source) + delta));
    }
  }

  public decayConnections(userId: string, decayFactor: number): void {
    for (const conn of this.connections) {
      conn.weight = Math.max(0.0, conn.weight * decayFactor);
    }
  }

  public pruneConnections(userId: string, threshold: number): void {
    this.connections = this.connections.filter(c => c.weight >= threshold);
  }

  private getWeight(sourceId: string, targetId: string): number {
    const c = this.connections.find(conn => conn.sourceId === sourceId && conn.targetId === targetId);
    return c ? c.weight : 0.5; // Default baseline is 0.5
  }
}

describe("Neural Spark Engine & Spreading Activation", () => {
  it("should propagate potentials to neighbors correctly up to 2 hops", () => {
    const store = new MockMemoryStore() as any as IMemoryStore;
    const engine = new NeuralSparkEngine(store);

    // Setup network: A -> B -> C
    // Weight A -> B: 0.8
    // Weight B -> C: 0.9
    store.upsertConnection("user-1", "node-A", "node-B", 0.8);
    store.upsertConnection("user-1", "node-B", "node-C", 0.9);

    // Initial inputs: node-A starts with potential 1.0 (fired)
    const initialNodes = [
      { id: "node-A", potential: 1.0, fired: false },
      { id: "node-B", potential: 0.0, fired: false },
      { id: "node-C", potential: 0.0, fired: false },
    ];

    const results = engine.propagateSparks("user-1", initialNodes);

    // Node-B potential = 1.0 * 0.8 = 0.8 (since 0.8 >= 0.7, it fires)
    // Node-C potential = 0.8 * 0.9 = 0.72 (since 0.72 >= 0.7, it fires)
    const nodeA = results.find(n => n.id === "node-A");
    const nodeB = results.find(n => n.id === "node-B");
    const nodeC = results.find(n => n.id === "node-C");

    expect(nodeA?.fired).toBe(true);
    expect(nodeB?.fired).toBe(true);
    expect(nodeB?.potential).toBeCloseTo(0.8);
    expect(nodeC?.fired).toBe(true);
    expect(nodeC?.potential).toBeCloseTo(0.72);
  });

  it("should respect refractory period and avoid double firing/infinite loops", () => {
    const store = new MockMemoryStore() as any as IMemoryStore;
    const engine = new NeuralSparkEngine(store);

    // Cycle network: A -> B -> A
    store.upsertConnection("user-1", "node-A", "node-B", 0.9);
    store.upsertConnection("user-1", "node-B", "node-A", 0.9);

    const initialNodes = [
      { id: "node-A", potential: 1.0, fired: false },
    ];

    const results = engine.propagateSparks("user-1", initialNodes);

    const nodeA = results.find(n => n.id === "node-A");
    const nodeB = results.find(n => n.id === "node-B");

    expect(nodeA?.fired).toBe(true);
    expect(nodeB?.fired).toBe(true);
    // Node-A potential shouldn't loop indefinitely
    expect(nodeA?.potential).toBe(1.0);
  });

  it("should strengthen co-cited pairs (Hebbian LTP)", () => {
    const store = new MockMemoryStore() as any as IMemoryStore;
    const engine = new NeuralSparkEngine(store);

    // Initial connection weight = 0.5
    store.upsertConnection("user-1", "node-A", "node-B", 0.5);
    store.upsertConnection("user-1", "node-B", "node-A", 0.5);

    // Co-cite A and B
    engine.strengthenSpines("user-1", ["node-A", "node-B"]);

    const connections = store.getConnectionsForSource("user-1", "node-A");
    const abConn = connections.find(c => c.targetId === "node-B");

    // LTP step is 0.15, so 0.5 + 0.15 = 0.65
    expect(abConn?.weight).toBeCloseTo(0.65);
  });

  it("should decay weights and prune weak connections (LTD)", () => {
    const store = new MockMemoryStore() as any as IMemoryStore;
    const engine = new NeuralSparkEngine(store);

    // node-A -> node-B: weight 0.8 (decays to 0.72)
    // node-A -> node-C: weight 0.1 (decays to 0.09 and gets pruned < 0.10)
    store.upsertConnection("user-1", "node-A", "node-B", 0.8);
    store.upsertConnection("user-1", "node-A", "node-C", 0.1);

    engine.decayAndPrune("user-1");

    const connections = store.getConnectionsForSource("user-1", "node-A");
    const abConn = connections.find(c => c.targetId === "node-B");
    const acConn = connections.find(c => c.targetId === "node-C");

    expect(abConn?.weight).toBeCloseTo(0.72);
    expect(acConn).toBeUndefined(); // Pruned!
  });
});
