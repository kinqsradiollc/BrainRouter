"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { useDiagnostics, useStats } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { StatCard } from "../../components/StatCard";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { useAuth } from "../../components/AuthProvider";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08
    }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 20 } }
} as const;

export default function Page() {
  const client = useMemo(() => getClient(), []);
  const { user } = useAuth();
  const { data } = useStats(client);
  const { data: diagnostics, error: diagnosticsError, isLoading: diagnosticsLoading } = useDiagnostics(
    client,
    undefined,
    { enabled: !!user?.isAdmin }
  );

  const formattedDate = useMemo(() => {
    if (!data?.lastRecallAt) return "Never";
    try {
      const d = new Date(data.lastRecallAt);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + " " + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return String(data.lastRecallAt);
    }
  }, [data?.lastRecallAt]);

  const envKeys = diagnostics?.envKeys ?? [];
  const recentErrors = diagnostics?.recentErrors ?? [];
  const sqliteVersion = diagnostics?.sqliteVersion ?? (diagnosticsLoading ? "Loading" : "Unavailable");
  const nodeVersion = diagnostics?.nodeVersion ?? (diagnosticsLoading ? "Loading" : "Unavailable");

  return (
    <AuthGuard>
      <motion.div 
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
        {/* Editorial Welcome Header */}
        <motion.div variants={itemVariants}>
          <PageHeader 
            title="Overview" 
            description="LTM (Long Term Memory) observability telemetry and citation graph analysis." 
          />
        </motion.div>

        {/* Stats Cards Bento Row */}
        <motion.div className="grid" variants={containerVariants} style={{ display: "grid", gap: "20px" }}>
          <StatCard title="Total Cognitive Records" value={data?.total ?? "0"} />
          <StatCard title="Archived Records" value={data?.archived ?? "0"} />
          <StatCard title="Citation Rate" value={data ? `${(data.citationRate * 100).toFixed(1)}%` : "0.0%"} />
          <StatCard title="Last Memory Recall" value={formattedDate} />
        </motion.div>

        {/* Asymmetric Bento Grid Details */}
        <div className="grid-asymmetric">
          {/* Left Column: Operational Telemetry */}
          <PremiumCard level={2} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 className="serif-display" style={{ fontSize: "20px", fontWeight: 500, margin: 0 }}>
                {user?.isAdmin ? "System Health & Signals" : "Memory Engine Status"}
              </h3>
              <span style={{ fontSize: "12px", color: "var(--color-golden-accent)", border: "1px solid var(--border-hover-accent)", borderRadius: "var(--radius-pill)", padding: "2px 8px", whiteSpace: "nowrap" }}>
                {user?.isAdmin && diagnosticsLoading ? "Checking" : "Active"}
              </span>
            </div>

            <p style={{ color: "var(--color-porcelain-text)", fontSize: "14px", margin: 0 }}>
              BrainRouter integrates a multi-layered hierarchical memory subsystem. The SensoryStream buffer captures user turns, consolidating them into CognitiveRecord files. Over time, recurring cognitive records are clustered by the background worker into ContextualFocus scenes and distilled into a CoreIdentity profile.
            </p>

            {user?.isAdmin ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)" }}>
                    <span style={{ color: "var(--color-stone-text)" }}>Database Engine</span>
                    <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>SQLite {sqliteVersion}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)" }}>
                    <span style={{ color: "var(--color-stone-text)" }}>Node Runtime</span>
                    <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>{nodeVersion}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)" }}>
                    <span style={{ color: "var(--color-stone-text)" }}>Citation Feedback loop</span>
                    <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>ACE Algorithm (Active)</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)" }}>
                    <span style={{ color: "var(--color-stone-text)" }}>Auto-Archive Decay Limit</span>
                    <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>10 non-cited turns</span>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "6px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
                    <span style={{ color: "var(--color-stone-text)", fontSize: "13px" }}>Environment Flags</span>
                    <span style={{ color: "var(--color-white-frost)", fontSize: "12px" }}>{envKeys.length}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {envKeys.length > 0 ? envKeys.map((key) => (
                      <span key={key} style={{ maxWidth: "100%", overflowWrap: "anywhere", fontSize: "11px", color: "var(--color-porcelain-text)", border: "1px solid var(--border-med)", borderRadius: "6px", padding: "4px 7px", background: "var(--overlay-bg)" }}>
                        {key}
                      </span>
                    )) : (
                      <span style={{ color: "var(--color-stone-text)", fontSize: "12px" }}>
                        No BrainRouter environment flags reported.
                      </span>
                    )}
                  </div>
                </div>

                {(diagnosticsError || recentErrors.length > 0) && (
                  <div style={{ marginTop: "4px", border: "1px solid rgba(239, 68, 68, 0.22)", borderRadius: "8px", background: "rgba(239, 68, 68, 0.06)", maxHeight: "180px", overflowY: "auto" }}>
                    {diagnosticsError && (
                      <div style={{ padding: "10px 12px", color: "#fca5a5", fontSize: "12px", borderBottom: recentErrors.length > 0 ? "1px solid rgba(239, 68, 68, 0.14)" : undefined }}>
                        Diagnostics unavailable: {diagnosticsError}
                      </div>
                    )}
                    {recentErrors.map((operation) => (
                      <div key={operation.id} style={{ padding: "10px 12px", borderBottom: "1px solid rgba(239, 68, 68, 0.12)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "12px" }}>
                          <span style={{ color: "var(--color-white-frost)", fontWeight: 500, overflowWrap: "anywhere" }}>{operation.operation}</span>
                          <span style={{ color: "var(--color-stone-text)", whiteSpace: "nowrap" }}>
                            {new Date(operation.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p style={{ color: "var(--color-porcelain-text)", fontSize: "12px", lineHeight: 1.45, margin: "6px 0 0", overflowWrap: "anywhere" }}>
                          {operation.reason || "No reason recorded"}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid var(--border-dim)" }}>
                  <span style={{ color: "var(--color-stone-text)" }}>Citation Feedback loop</span>
                  <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>ACE Algorithm (Active)</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0" }}>
                  <span style={{ color: "var(--color-stone-text)" }}>Auto-Archive Decay Limit</span>
                  <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>10 non-cited turns</span>
                </div>
              </div>
            )}
          </PremiumCard>

          {/* Right Column: Mini Guidelines */}
          <PremiumCard level={3} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <h3 className="serif-display" style={{ fontSize: "20px", fontWeight: 500, margin: 0 }}>
              API Status
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", boxShadow: "0 0 8px #10b981" }} />
              <span style={{ fontSize: "14px", fontWeight: 500, color: "var(--color-pure-white)" }}>Server Connected</span>
            </div>
            <p style={{ color: "var(--color-stone-text)", fontSize: "12px", lineHeight: 1.5, margin: 0, marginTop: "8px" }}>
              All telemetry metrics are fetched securely from the active BrainRouter daemon running on port 3747.
            </p>
          </PremiumCard>
        </div>
      </motion.div>
    </AuthGuard>
  );
}
