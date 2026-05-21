"use client";

import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useScenes } from "@brainrouter/hooks";
import type { ContextualFocusRecord } from "@brainrouter/types";
import { getClient } from "../../lib/client";
import { SceneCard } from "../../components/SceneCard";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
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

export default function ScenesPage() {
  const client = useMemo(() => getClient(), []);
  const { scenes, loadMore, hasMore, isFetchingMore } = useScenes(client);

  return (
    <AuthGuard>
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        {/* Title block */}
        <PageHeader 
          title="Contextual Focus" 
          description="Consolidated narrative themes and high-level episodic contexts summarizing memory logs." 
        />

        {/* Grid container with stagger entries */}
        <motion.div 
          className="grid"
          variants={containerVariants}
          initial="hidden"
          animate="show"
          style={{ alignItems: "start" }}
        >
          <AnimatePresence mode="popLayout">
            {scenes.map((scene: ContextualFocusRecord) => (
              <SceneCard key={scene.id} scene={scene} />
            ))}
          </AnimatePresence>
        </motion.div>
        <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />

        {/* Empty State */}
        {scenes.length === 0 && (
          <EmptyState
            icon={
              <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M8.25 21v-4.875c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125V21m0 0h4.5V3.545M12.75 21h7.5V10.75M2.25 21h1.5m18 0h-18M2.25 9l4.5-1.636M18.75 3l-1.5.545m0 6.205 3 1M2.25 9v12m0-12h3m0 0 3-1.091M6.75 7.364V21m-3-12v12m0-12v12" />
              </svg>
            }
            title="No Consolidated Focus Scenes"
            description="The background worker automatically consolidates recurring cognitive memories into focus scenes periodically."
          />
        )}
      </motion.div>
    </AuthGuard>
  );
}
