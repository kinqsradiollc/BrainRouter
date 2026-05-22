# 🧠 Proposal: Neural Sparks & Synaptic Spine Plasticity in BrainRouter

This proposal outlines the implementation plan for mapping biological neuroscientific principles—**neurons**, **dendritic spines**, and **action potentials ("sparks")**—into the BrainRouter memory retrieval and consolidation engine. This framework enhances RAG by replacing standard vector lookup with dynamic spreading activation and structural connection plasticity.

---

## 🧬 1. The Neurobiological Mapping

We map biological neural components directly to data structures and runtime processes in the BrainRouter memory stack:

```
 Biological Brain                 BrainRouter Memory Engine
 ┌────────────────┐               ┌────────────────────────┐
 │ Neuron         │  ──────────►  │ CognitiveRecord Node   │ (Base unit of memory)
 └────────────────┘               └────────────────────────┘
 ┌────────────────┐               ┌────────────────────────┐
 │ Dendritic Spine│  ──────────►  │ Graph Relationship Edge│ (Dynamic synaptic weight)
 └────────────────┘               └────────────────────────┘
 ┌────────────────┐               ┌────────────────────────┐
 │ Action Potential│ ──────────►  │ Firing Threshold (θ)   │ (Retrieval & propagation)
 └────────────────┘               └────────────────────────┘
 ┌────────────────┐               ┌────────────────────────┐
 │ LTP / LTD      │  ──────────►  │ Co-citation / decay    │ (Hebbian connection adjustment)
 └────────────────┘               └────────────────────────┘
```

### A. Neuron $\rightarrow$ CognitiveRecord (Node)
*   Each `CognitiveRecord` (a fact, codebase rule, or task context) represents a single **neuron**.
*   Each neuron maintains a dynamic state variable: **Membrane Potential ($V_m$)**, which represents its current level of activation. The default resting potential is $V_0 = 0.0$, and the maximum active potential is $1.0$.

### B. Dendritic Spines $\rightarrow$ Associative Links (Edges)
*   The edges between nodes in our Knowledge Graph represent **dendritic spines** (synapses).
*   Each connection carries a dynamic **Synaptic Weight ($W_{ij}$)** representing the connection strength.
*   Spines are highly plastic: they grow (weight increases) when memories are co-accessed, and shrink (weight decays/prunes) if the connection goes unused.

### C. Action Potential / "Spark" $\rightarrow$ Firing Threshold
*   When user queries excite a set of memory nodes, their potentials rise. If a node's potential crosses the **Firing Threshold ($\theta = 0.70$)**, it **fires (sparks)**.
*   **Sparking** causes two immediate effects:
    1.  The memory is forced into the active prompt context.
    2.  An **excitatory post-synaptic current** propagates downstream along its "spines" (edges) to excite connected neighbor nodes, pulling associated context into search even if they didn't match the search keywords directly.

---

## 📐 2. Mathematical Models & Mechanics

### A. Membrane Potential Accumulation ($V_m$)
When a user query $Q$ is received, the membrane potential $V_m(i)$ for each candidate memory node $i$ is calculated:

$$V_m(i) = V_{\text{decayed}}(i) + I_i + A_i$$

*   $V_{\text{decayed}}(i)$ is the Ebbinghaus decayed priority of the memory based on its category.
*   $I_i$ is the **Sensory Input Current** derived from lexical (BM25) and semantic (Vector) similarity:
    $$I_i = w_{\text{lex}} \cdot S_{\text{BM25}}(i, Q) + w_{\text{sem}} \cdot S_{\text{Vector}}(i, Q)$$
*   $A_i$ is the **Intent Affinity depolarizing current** (e.g., if a developer error is detected, a current boost of $+0.2$ is applied to debugging and rule memories).

---

### B. Action Potential Firing & Spreading Activation
If $V_m(i) \geq \theta$ (Threshold $\theta = 0.70$), the node **fires a "spark"**:

1.  **Axonal Propagation**: The firing node transmits an electrical current to all adjacent neighbor nodes $j$ via their connections (spines):
    $$I_{\text{prop}}(j) = V_m(i) \times W_{ij}$$
    where $W_{ij} \in [0, 1]$ is the weight of the dendritic spine.
2.  **Secondary Stimulation**: Neighbors update their potentials:
    $$V_m(j) \leftarrow \min(1.0, V_m(j) + I_{\text{prop}}(j))$$
    If a neighbor node $j$'s potential now exceeds $\theta$, it fires in turn, cascading up to a limit of 2 hops.
3.  **Refractory Period**: To prevent runaway feedback loops and over-excitation (epileptic loop state), any node that fires enters a refractory state. Its potential is reset to $0.0$, and it cannot fire again during the current query turn.

---

### C. Synaptic Plasticity (Spine Growth & Pruning)
Connections in the graph adjust dynamically based on usage (Hebbian learning: *"neurons that fire together, wire together"*):

*   **Long-Term Potentiation (LTP) / Spine Growth**:
    If memory node $i$ and node $j$ are retrieved and **jointly cited** by the agent during a session, the spine between them grows:
    $$W_{ij} \leftarrow \min(1.0, W_{ij} + \Delta_{\text{LTP}}), \quad \Delta_{\text{LTP}} = 0.15$$

*   **Long-Term Depression (LTD) / Spine Pruning**:
    During the consolidation phase, all graph edges undergo decay over time:
    $$W_{ij} \leftarrow W_{ij} \times e^{-\lambda_{\text{spine}} \cdot t}$$
    If a spine's weight drops below the structural threshold ($W_{ij} < 0.10$), the **spine retracts**—meaning the relationship edge is deleted from the SQLite database to keep the graph compact and clean.

---

## 🛠️ 3. Proposed Code Architecture

We can implement this by introducing a new module `brainrouter/src/memory/pipeline/neural-spark.ts` and integrating it directly into `brainrouter/src/memory/recall.ts`.

### Step A: Database Schema Extension
Update `brainrouter/src/memory/store/sqlite.ts` to track edge weights and resting activation levels:
```sql
-- Track dynamic relationship edge weights (dendritic spines)
CREATE TABLE IF NOT EXISTS cognitive_connections (
    source_id TEXT,
    target_id TEXT,
    weight REAL DEFAULT 0.5, -- Synaptic Weight (W_ij)
    last_activated_at DATETIME,
    PRIMARY KEY (source_id, target_id),
    FOREIGN KEY (source_id) REFERENCES cognitive_records(record_id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES cognitive_records(record_id) ON DELETE CASCADE
);
```

### Step B: The Spark Propagation Engine
Create `brainrouter/src/memory/pipeline/neural-spark.ts`:
```typescript
import type { Database } from "better-sqlite3";

export interface SparkNode {
  id: string;
  potential: number;
  fired: boolean;
}

export class NeuralSparkEngine {
  private readonly threshold = 0.70;
  private readonly ltpStep = 0.15;
  private readonly spineDecayRate = 0.05; // half-life based decay

  constructor(private db: Database) {}

  /**
   * Spreads potential from fired nodes to their neighbors.
   */
  public propagateSparks(initialNodes: SparkNode[]): SparkNode[] {
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

        // Retrieve connections (spines) from DB
        const connections = this.db.prepare(`
          SELECT target_id, weight FROM cognitive_connections 
          WHERE source_id = ? AND weight >= 0.1
        `).all(sourceId) as { target_id: string; weight: number }[];

        for (const conn of connections) {
          let target = activeNodes.get(conn.target_id);
          if (!target) {
            target = { id: conn.target_id, potential: 0.0, fired: false };
            activeNodes.set(conn.target_id, target);
          }

          // Refractory check
          if (target.fired) continue;

          // Propagate post-synaptic potential: source_potential * W_ij
          const psp = sourceNode.potential * conn.weight;
          target.potential = Math.min(1.0, target.potential + psp);

          // Spark check
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
  public strengthenSpines(citedIds: string[]): void {
    if (citedIds.length < 2) return;
    
    // Strengthen connection between all cited pairs (co-firing)
    const stmt = this.db.prepare(`
      INSERT INTO cognitive_connections (source_id, target_id, weight, last_activated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(source_id, target_id) DO UPDATE SET
        weight = MIN(1.0, weight + ?),
        last_activated_at = datetime('now')
    `);

    for (let i = 0; i < citedIds.length; i++) {
      for (let j = i + 1; j < citedIds.length; j++) {
        stmt.run(citedIds[i], citedIds[j], this.ltpStep, this.ltpStep);
        stmt.run(citedIds[j], citedIds[i], this.ltpStep, this.ltpStep); // bi-directional
      }
    }
  }
}
```

---

## 📈 4. Visualizing Sparks in the Dashboard

We can represent this beautifully in our Next.js dashboard visualizer:
1.  **Dendritic Spine Thickness**: Render connections as lines whose thickness and opacity are bound to `weight` ($W_{ij}$). Thick, bright lines represent fully developed spines; thin, faint lines represent decaying, weak spines.
2.  **Firing Action Potential**: When a node is sparked, trigger a visual expansion pulse (scaling effect) and send glowing particles (yellow/golden) flowing down the connected lines (spines) to stimulate neighbors.
3.  **Refractory State**: Nodes that just fired can temporarily display a cool blue/gray halo representing their refractory state.
