"use client";

import { motion } from "framer-motion";

interface MemoryBadgeProps {
  score: number;
}

export function MemoryBadge({ score }: MemoryBadgeProps) {
  // score = m.neverCitedCount (0 = highly active/cited; high = decaying/never cited)
  const isActive = score === 0;
  const isDecaying = score >= 5;

  let badgeStyle = {
    background: "linear-gradient(90deg, rgba(204, 145, 102, 0.15) 0%, rgba(204, 145, 102, 0.03) 100%)",
    borderColor: "rgba(204, 145, 102, 0.4)",
    color: "var(--color-pure-white)",
    text: "Cited Active"
  };

  if (isDecaying) {
    badgeStyle = {
      background: "linear-gradient(90deg, rgba(94, 97, 110, 0.1) 0%, rgba(94, 97, 110, 0.02) 100%)",
      borderColor: "rgba(94, 97, 110, 0.3)",
      color: "var(--color-stone-text)",
      text: `Decay: ${score}`
    };
  } else if (!isActive) {
    badgeStyle = {
      background: "linear-gradient(90deg, rgba(226, 227, 233, 0.08) 0%, rgba(226, 227, 233, 0.02) 100%)",
      borderColor: "rgba(226, 227, 233, 0.2)",
      color: "var(--color-porcelain-text)",
      text: `Stable: ${score}`
    };
  }

  return (
    <motion.span
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ scale: 1.05 }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: "var(--radius-pill)",
        padding: "3px 10px",
        border: "1px solid",
        borderColor: badgeStyle.borderColor,
        background: badgeStyle.background,
        color: badgeStyle.color,
        fontSize: "12px",
        fontWeight: 600,
        fontFamily: "var(--font-inter)",
        letterSpacing: "0.02em",
        boxShadow: isActive ? "0 0 10px rgba(204, 145, 102, 0.1)" : "none",
        cursor: "default",
        userSelect: "none"
      }}
    >
      {/* Dynamic Status Dot */}
      <span 
        style={{ 
          width: "5px", 
          height: "5px", 
          borderRadius: "50%", 
          marginRight: "6px",
          background: isActive ? "var(--color-golden-accent)" : isDecaying ? "#ef4444" : "var(--color-silver-text)",
          boxShadow: isActive ? "0 0 6px var(--color-golden-accent)" : "none"
        }} 
      />
      {badgeStyle.text}
    </motion.span>
  );
}
