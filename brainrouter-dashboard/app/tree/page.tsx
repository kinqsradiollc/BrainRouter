"use client";

// 0.4.3 — Memory Tree view. The durable summary hierarchy (source/topic/global)
// — append leaf → seal bucket → summarize parent → walk/drill. Surfaces
// memory_tree_walk: list roots, click to drill into children.

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { MemoryTreeNode } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";

function NodeRow({ node, depth, onDrill, children, openIds }: {
  node: MemoryTreeNode;
  depth: number;
  onDrill: (id: string) => void;
  children: Record<string, MemoryTreeNode[] | "loading">;
  openIds: Set<string>;
}) {
  const open = openIds.has(node.id);
  const loaded = children[node.id];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginLeft: depth ? "16px" : 0, borderLeft: depth ? "1px solid var(--color-border, #2a2a2a)" : "none", paddingLeft: depth ? "10px" : 0 }}>
      <button
        onClick={() => onDrill(node.id)}
        style={{ display: "flex", justifyContent: "space-between", gap: "12px", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, width: "100%" }}
      >
        <span style={{ color: "var(--color-white-frost)", fontSize: "13px", overflowWrap: "anywhere" }}>
          <span style={{ color: "var(--color-golden-accent)", fontSize: "11px", letterSpacing: "0.08em", marginRight: "8px" }}>{node.kind.toUpperCase()} L{node.level}</span>
          {node.summaryMd?.slice(0, 120) || "(no summary)"}
        </span>
        <span style={{ color: "var(--color-stone-text)", fontSize: "11px", whiteSpace: "nowrap" }}>
          {node.sourceChunkIds?.length ?? 0} chunks{node.sealedAt ? " · sealed" : ""} · {open ? "▾" : "▸"}
        </span>
      </button>
      {open && loaded === "loading" && <p style={{ color: "var(--color-stone-text)", fontSize: "12px", margin: 0 }}>Loading children…</p>}
      {open && Array.isArray(loaded) && loaded.length === 0 && <p style={{ color: "var(--color-stone-text)", fontSize: "12px", margin: 0 }}>Leaf (no children).</p>}
      {open && Array.isArray(loaded) && loaded.map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} onDrill={onDrill} children={children} openIds={openIds} />
      ))}
    </div>
  );
}

export default function TreePage() {
  const client = useMemo(() => getClient(), []);
  const [roots, setRoots] = useState<MemoryTreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, MemoryTreeNode[] | "loading">>({});
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    client
      .getTreeRoots()
      .then((r) => setRoots(r.roots ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  const onDrill = async (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (children[id] === undefined) {
      setChildren((c) => ({ ...c, [id]: "loading" }));
      try {
        const r = await client.getTreeChildren(id);
        setChildren((c) => ({ ...c, [id]: r.children ?? [] }));
      } catch {
        setChildren((c) => ({ ...c, [id]: [] }));
      }
    }
  };

  return (
    <AuthGuard>
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
        <PageHeader
          title="Memory Tree"
          description="The durable summary hierarchy — leaves roll up into sealed, summarized parents across source / topic / global scope. Click a node to drill into its children."
        />
        {error && <p style={{ color: "#fca5a5", fontSize: "13px" }}>Could not load tree: {error}</p>}
        {!roots && !error && <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>Loading…</p>}
        {roots && roots.length === 0 && (
          <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>No tree nodes yet. They form as memory accumulates and buckets are sealed (0.4.3).</p>
        )}
        <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {roots?.map((n) => (
            <NodeRow key={n.id} node={n} depth={0} onDrill={onDrill} children={children} openIds={openIds} />
          ))}
        </div>
      </motion.div>
    </AuthGuard>
  );
}
