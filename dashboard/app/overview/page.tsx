"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { useStats } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { StatCard } from "../../components/StatCard";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";

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
  const { data } = useStats(client);

  const formattedDate = useMemo(() => {
    if (!data?.lastRecallAt) return "Never";
    try {
      const d = new Date(data.lastRecallAt);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + " " + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return String(data.lastRecallAt);
    }
  }, [data?.lastRecallAt]);

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
          <StatCard title="Total Memories (L1)" value={data?.total ?? "0"} />
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
                System Health & Signals
              </h3>
              <span style={{ fontSize: "12px", color: "var(--color-golden-accent)", border: "1px solid rgba(204, 145, 102, 0.2)", borderRadius: "var(--radius-pill)", padding: "2px 8px" }}>
                Active
              </span>
            </div>

            <p style={{ color: "var(--color-porcelain-text)", fontSize: "14px", margin: 0 }}>
              BrainRouter integrates a multi-layered hierarchical memory subsystem. L1 memories represent semantic episodes extracted from turns. Over time, recurring L1 episodes are consolidated by the background worker into L2 Scenes and distilled into an L3 Persona profile.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid rgba(226, 227, 233, 0.04)" }}>
                <span style={{ color: "var(--color-stone-text)" }}>Database Engine</span>
                <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>SQLite (FTS5 + Vector)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0", borderBottom: "1px solid rgba(226, 227, 233, 0.04)" }}>
                <span style={{ color: "var(--color-stone-text)" }}>Citation Feedback loop</span>
                <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>ACE Algorithm (Active)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "8px 0" }}>
                <span style={{ color: "var(--color-stone-text)" }}>Auto-Archive Decay Limit</span>
                <span style={{ color: "var(--color-white-frost)", fontWeight: 500 }}>10 non-cited turns</span>
              </div>
            </div>
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
