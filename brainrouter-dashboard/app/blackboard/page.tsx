"use client";

// 0.4.3 — Blackboard view. The staging area between extraction and long-term
// memory: candidates are staged, reconciled (dedup/score), then committed to
// cognitive records or rejected. This surfaces memory_blackboard_review.

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { BlackboardItem } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--color-stone-text)",
  reconciled: "var(--color-golden-accent)",
  duplicate: "#a78bfa",
  committed: "#4ade80",
  rejected: "#fca5a5",
};

export default function BlackboardPage() {
  const client = useMemo(() => getClient(), []);
  const [items, setItems] = useState<BlackboardItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .getBlackboard()
      .then((r) => setItems(r.items ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  return (
    <AuthGuard>
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
        <PageHeader
          title="Blackboard"
          description="Extracted memory candidates staged for review — reconciled (dedup/score), then committed to cognitive records or rejected."
        />
        {error && <p style={{ color: "#fca5a5", fontSize: "13px" }}>Could not load blackboard: {error}</p>}
        {!items && !error && <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>Loading…</p>}
        {items && items.length === 0 && (
          <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>No staged candidates. Items appear here before they commit to long-term memory (0.4.3).</p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {items?.map((it) => (
            <div key={it.id} className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <span style={{ color: STATUS_COLOR[it.status] ?? "var(--color-stone-text)", fontSize: "11px", letterSpacing: "0.08em", fontWeight: 700 }}>
                  {it.status.toUpperCase()} · {it.candidate?.type}
                </span>
                <span style={{ color: "var(--color-stone-text)", fontSize: "11px" }}>
                  score {it.score?.toFixed?.(2) ?? it.score}{it.conflictIds?.length ? ` · ${it.conflictIds.length} conflict${it.conflictIds.length === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              <p style={{ color: "var(--color-white-frost)", fontSize: "13px", margin: 0, overflowWrap: "anywhere" }}>{it.candidate?.content}</p>
              {it.committedRecordId && <span style={{ color: "#4ade80", fontSize: "11px" }}>→ committed: {it.committedRecordId}</span>}
            </div>
          ))}
        </div>
      </motion.div>
    </AuthGuard>
  );
}
