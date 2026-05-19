"use client";

import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useMemories } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { MemoryBadge } from "../../components/MemoryBadge";
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
      staggerChildren: 0.05
    }
  }
};

const rowVariants = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 300, damping: 22 } },
  exit: { opacity: 0, x: -20, height: 0, padding: 0, transition: { duration: 0.2 } }
} as const;

export default function MemoriesPage() {
  const client = useMemo(() => getClient(), []);
  const { memories, refresh, loadMore, hasMore, isFetchingMore } = useMemories(client);

  return (
    <AuthGuard>
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        {/* Title */}
        <PageHeader 
          title="Memories (L1)" 
          description="Semantic episode logs extracted from user conversational contexts." 
        />

        {/* Glassmorphic Table Container */}
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "120px" }}>Type</th>
                <th>Content</th>
                <th style={{ width: "150px" }}>Scene Link</th>
                <th style={{ width: "140px" }}>Decay Status</th>
                <th style={{ width: "110px", textAlign: "right" }} />
              </tr>
            </thead>
            <motion.tbody 
              variants={containerVariants}
              initial="hidden"
              animate="show"
            >
              <AnimatePresence mode="popLayout">
                {memories.map((m: any) => (
                  <motion.tr 
                    key={m.recordId}
                    variants={rowVariants}
                    exit="exit"
                    layout
                  >
                    <td style={{ fontWeight: 600, color: "var(--color-pure-white)", fontSize: "13px" }}>
                      <span 
                        style={{ 
                          border: "1px solid rgba(226, 227, 233, 0.1)",
                          borderRadius: "4px",
                          padding: "2px 6px",
                          background: "var(--color-pewter-accent)",
                          fontSize: "11px",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em"
                        }}
                      >
                        {m.type}
                      </span>
                    </td>
                    <td style={{ lineHeight: 1.5 }}>{m.content}</td>
                    <td style={{ color: "var(--color-silver-text)", fontSize: "13px" }}>
                      {m.sceneName || <span style={{ color: "var(--color-stone-text)" }}>None</span>}
                    </td>
                    <td>
                      <MemoryBadge score={m.neverCitedCount} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <PremiumButton 
                        variant="danger" 
                        style={{ padding: "6px 14px", fontSize: "12px" }}
                        onClick={() => client.archiveMemory(m.recordId).then(refresh)}
                      >
                        Archive
                      </PremiumButton>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </motion.tbody>
          </table>

          {/* Empty State */}
          {memories.length === 0 && (
            <EmptyState
              icon={
                <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              }
              title="No Semantic Memories"
              description="Active agent sessions will populate this index once memory recall is performed."
            />
          )}
          <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />
        </div>
      </motion.div>
    </AuthGuard>
  );
}
