"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

interface InfiniteScrollSentinelProps {
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
}

export function InfiniteScrollSentinel({ hasMore, isFetchingMore, onLoadMore }: InfiniteScrollSentinelProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetchingMore) {
          onLoadMore();
        }
      },
      { rootMargin: "320px 0px", threshold: 0.1 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, onLoadMore]);

  if (!hasMore) return null;

  return (
    <motion.div
      ref={sentinelRef}
      aria-live="polite"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      style={{
        minHeight: "72px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px 0 4px"
      }}
    >
      <motion.div
        animate={{ opacity: isFetchingMore ? 1 : 0.45, scale: isFetchingMore ? 1 : 0.96 }}
        transition={{ duration: 0.2 }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          color: "var(--color-golden-accent)"
        }}
      >
        {[0, 1, 2].map((dot) => (
          <motion.span
            key={dot}
            animate={{
              y: isFetchingMore ? [0, -5, 0] : [0, -2, 0],
              opacity: isFetchingMore ? [0.45, 1, 0.45] : [0.25, 0.5, 0.25]
            }}
            transition={{
              duration: isFetchingMore ? 0.75 : 1.4,
              repeat: Infinity,
              delay: dot * 0.12,
              ease: "easeInOut"
            }}
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: "currentColor",
              boxShadow: "0 0 10px rgba(174, 147, 87, 0.35)"
            }}
          />
        ))}
      </motion.div>
    </motion.div>
  );
}
