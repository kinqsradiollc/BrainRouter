"use client";

import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useContradictions } from "@brainrouter/hooks";
import type { ContradictionRecord } from "@brainrouter/types";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
import { PremiumButton } from "../../components/PremiumButton";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08
    }
  }
};

const cardVariants = {
  hidden: { opacity: 0, y: 15 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 20 } },
  exit: { 
    opacity: 0, 
    scale: 0.95,
    x: -30,
    transition: { duration: 0.22, ease: "easeOut" } 
  }
} as const;

export default function ContradictionsPage() {
  const client = useMemo(() => getClient(), []);
  const { contradictions, refresh, loadMore, hasMore, isFetchingMore } = useContradictions(client);

  return (
    <AuthGuard>
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        {/* Editorial Title */}
        <PageHeader 
          title="Contradictions" 
          description="Unresolved semantic conflicts detected in the L1/L2 memory layer." 
        />

        {/* Contradictions Queue */}
        <motion.div 
          variants={containerVariants}
          initial="hidden"
          animate="show"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          <AnimatePresence mode="popLayout">
            {contradictions.map((c: ContradictionRecord) => (
              <motion.div 
                key={c.id} 
                className="card"
                variants={cardVariants}
                exit="exit"
                layout
                style={{ 
                  display: "flex", 
                  justifyContent: "space-between", 
                  alignItems: "center",
                  gap: "24px"
                }}
              >
                <div>
                  <strong 
                    className="serif-display" 
                    style={{ 
                      color: "var(--color-pure-white)", 
                      display: "block",
                      fontSize: "18px",
                      fontWeight: 500
                    }}
                  >
                    {c.reason}
                  </strong>
                  <p 
                    style={{ 
                      color: "var(--color-porcelain-text)", 
                      margin: "6px 0 0 0",
                      fontSize: "14px",
                      lineHeight: 1.5
                    }}
                  >
                    {[c.content_a ?? c.contentA, c.content_b ?? c.contentB].filter(Boolean).join(" <-> ") || `Confidence ${c.confidence.toFixed(2)}`}
                  </p>
                </div>

                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <PremiumButton 
                    variant="ghost" 
                    style={{ padding: "8px 18px", fontSize: "13px" }}
                    onClick={() => client.resolveContradiction(c.id, "resolved").then(refresh)}
                  >
                    Resolve
                  </PremiumButton>
                  <PremiumButton 
                    variant="text" 
                    style={{ padding: "8px 18px", fontSize: "13px" }}
                    onClick={() => client.resolveContradiction(c.id, "dismissed").then(refresh)}
                  >
                    Dismiss
                  </PremiumButton>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>

        {/* Elegant Empty State */}
        {contradictions.length === 0 && (
          <EmptyState
            icon={
              <div 
                style={{ 
                  width: "48px", 
                  height: "48px", 
                  borderRadius: "50%", 
                  background: "rgba(16, 185, 129, 0.08)",
                  border: "1px solid rgba(16, 185, 129, 0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#10b981",
                  marginBottom: "4px"
                }}
              >
                <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              </div>
            }
            title="Semantic Coherence Attained"
            description="The memory engine has detected no overlapping or contradictory belief systems."
          />
        )}
        <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />
      </motion.div>
    </AuthGuard>
  );
}
