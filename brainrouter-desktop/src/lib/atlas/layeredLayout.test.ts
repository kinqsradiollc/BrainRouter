import test from "node:test";
import assert from "node:assert/strict";
import { layeredLayout } from "./layeredLayout.js";

function boundsWidth(pos: Map<string, { x: number; y: number }>, nodes: Array<{ id: string; width: number }>): number {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + n.width);
  }
  return maxX - minX;
}

test("layeredLayout wraps overly wide top-bottom ranks", () => {
  const nodes = [
    { id: "root", width: 180, height: 90 },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `leaf-${i}`, width: 180, height: 90 })),
  ];
  const edges = nodes.slice(1).map((n) => ({ source: "root", target: n.id }));

  const wide = layeredLayout(nodes, edges, { nodesep: 40, ranksep: 80 });
  const compact = layeredLayout(nodes, edges, { nodesep: 40, ranksep: 80, maxWidth: 720 });

  assert.ok(boundsWidth(wide, nodes) > 720);
  assert.ok(boundsWidth(compact, nodes) <= 720);
  assert.equal(compact.size, nodes.length);
});
