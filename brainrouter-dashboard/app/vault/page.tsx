"use client";

// 0.4.3 — Vault view. A read-only markdown mirror of records + tree nodes with
// a hash ledger (idempotent re-export; the DB stays authoritative). Surfaces
// the memory_vault_export ledger.

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { VaultExportEntry } from "@kinqs/brainrouter-types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";

export default function VaultPage() {
  const client = useMemo(() => getClient(), []);
  const [exports, setExports] = useState<VaultExportEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .getVaultExports()
      .then((r) => setExports(r.exports ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  return (
    <AuthGuard>
      <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
        <PageHeader
          title="Vault"
          description="Read-only markdown mirror of records + tree nodes, with a hash ledger so re-export only rewrites what changed. The database stays authoritative."
        />
        {error && <p style={{ color: "#fca5a5", fontSize: "13px" }}>Could not load vault: {error}</p>}
        {!exports && !error && <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>Loading…</p>}
        {exports && exports.length === 0 && (
          <p style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>No vault exports yet. Run <code>memory_vault_export</code> to mirror memory to markdown (0.4.3).</p>
        )}
        {exports && exports.length > 0 && (
          <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ color: "var(--color-stone-text)", fontSize: "12px" }}>{exports.length} exported file{exports.length === 1 ? "" : "s"}</div>
            {exports.map((e) => (
              <div key={e.path} style={{ display: "flex", justifyContent: "space-between", gap: "12px", borderLeft: "2px solid var(--color-golden-accent)", paddingLeft: "10px" }}>
                <span style={{ color: "var(--color-white-frost)", fontSize: "13px", overflowWrap: "anywhere" }}>
                  <span style={{ color: "var(--color-golden-accent)", fontSize: "11px", letterSpacing: "0.08em", marginRight: "8px" }}>{e.kind.toUpperCase()}</span>
                  {e.path}
                </span>
                <span style={{ color: "var(--color-stone-text)", fontSize: "11px", whiteSpace: "nowrap" }}>{e.hash.slice(0, 8)} · {new Date(e.exportedAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </AuthGuard>
  );
}
