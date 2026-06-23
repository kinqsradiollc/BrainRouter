import type { IMemoryStore } from "@kinqs/brainrouter-types";

export interface SparkNode {
  id: string;
  potential: number;
  fired: boolean;
}

export class NeuralSparkEngine {
  private readonly threshold = 0.70;
  private readonly ltpStep = 0.15;
  private readonly decayFactor = 0.90; // Default decay multiplier (LTD)
  private readonly pruneThreshold = 0.10;
  // Spreading activation is on by default. Set BRAINROUTER_NEURAL_SPARK_ENABLED=false
  // to disable propagation, Hebbian strengthening, and synaptic decay/pruning;
  // recall then ranks on the plain scored/reranked candidate set. Mirrors the
  // opt-out semantics of BRAINROUTER_GRAPH_ENABLED.
  private readonly enabled = process.env.BRAINROUTER_NEURAL_SPARK_ENABLED !== "false";

  constructor(private store: IMemoryStore) {}

  /**
   * Propagates potentials from fired nodes to their neighbors.
   * Runs a 2-hop BFS.
   */
  public async propagateSparks(userId: string, initialNodes: SparkNode[]): Promise<SparkNode[]> {
    // Disabled: hand the seed nodes back untouched so recall ranks on the
    // pre-spark scores — no neighbors pulled in, no firing boost.
    if (!this.enabled) return initialNodes;

    const activeNodes = new Map<string, SparkNode>(
      initialNodes.map(node => [node.id, { ...node, fired: false }])
    );

    const queue: string[] = [];

    // 1. Detect initial nodes crossing threshold
    for (const node of initialNodes) {
      if (node.potential >= this.threshold) {
        const active = activeNodes.get(node.id)!;
        active.fired = true;
        queue.push(node.id);
      }
    }

    // 2. Propagate potential (2-hop limit)
    let hops = 0;
    while (queue.length > 0 && hops < 2) {
      const currentSize = queue.length;

      for (let i = 0; i < currentSize; i++) {
        const sourceId = queue.shift()!;
        const sourceNode = activeNodes.get(sourceId)!;

        // Retrieve connections (dendritic spines) from store
        const connections = await this.store.getConnectionsForSource(userId, sourceId);

        for (const conn of connections) {
          let target = activeNodes.get(conn.targetId);
          if (!target) {
            target = { id: conn.targetId, potential: 0.0, fired: false };
            activeNodes.set(conn.targetId, target);
          }

          // Refractory check: if it already fired, don't excite it again
          if (target.fired) continue;

          // Propagate post-synaptic potential: source_potential * W_ij
          const psp = sourceNode.potential * conn.weight;
          target.potential = Math.min(1.0, target.potential + psp);

          // Firing check
          if (target.potential >= this.threshold) {
            target.fired = true;
            queue.push(target.id);
          }
        }
      }
      hops++;
    }

    return Array.from(activeNodes.values());
  }

  /**
   * Hebbian Spine updates (LTP) for cited pairs
   */
  public async strengthenSpines(userId: string, citedIds: string[]): Promise<void> {
    if (!this.enabled) return;
    if (citedIds.length < 2) return;

    const pairs: Array<{ source: string; target: string }> = [];
    for (let i = 0; i < citedIds.length; i++) {
      for (let j = i + 1; j < citedIds.length; j++) {
        pairs.push({ source: citedIds[i], target: citedIds[j] });
      }
    }

    await this.store.strengthenConnectionsBatch(userId, pairs, this.ltpStep);
  }

  /**
   * Synaptic decay & pruning (LTD)
   */
  public async decayAndPrune(userId: string): Promise<void> {
    if (!this.enabled) return;
    await this.store.decayConnections(userId, this.decayFactor);
    await this.store.pruneConnections(userId, this.pruneThreshold);
  }
}
