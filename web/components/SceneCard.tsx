"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { PremiumCard } from "./PremiumCard";

interface SceneCardProps {
  scene: {
    id: string | number;
    sceneName: string;
    heatScore?: number | string;
    summaryMd?: string;
  };
}

export function SceneCard({ scene }: SceneCardProps) {
  const [expanded, setExpanded] = useState(false);
  const heat = Number(scene.heatScore ?? 0);

  return (
    <PremiumCard
      level={1}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ 
        y: -3,
        borderColor: "rgba(204, 145, 102, 0.2)"
      }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      style={{
        display: "flex",
        flexDirection: "column",
        cursor: "pointer"
      }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Card Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 
          className="serif-display" 
          style={{ 
            color: "var(--color-pure-white)", 
            fontSize: "18px", 
            fontWeight: 500, 
            margin: 0 
          }}
        >
          {scene.sceneName}
        </h3>
        <span 
          style={{ 
            fontSize: "14px", 
            color: "var(--color-golden-accent)", 
            fontWeight: 600,
            fontFamily: "var(--font-inter)" 
          }}
        >
          {heat.toFixed(0)} Heat
        </span>
      </div>

      {/* Spring Heat Progress Bar */}
      <div style={{ height: "6px", background: "var(--color-pewter-accent)", borderRadius: "9999px", marginTop: "12px", overflow: "hidden" }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(100, Math.max(0, heat))}%` }}
          transition={{ 
            type: "spring", 
            stiffness: 80, 
            damping: 15,
            delay: 0.1
          }}
          style={{ 
            height: "100%", 
            borderRadius: "9999px", 
            background: "var(--color-golden-accent)",
            boxShadow: "0 0 8px var(--color-golden-accent)"
          }}
        />
      </div>

      {/* Click to expand prompt */}
      <div 
        style={{ 
          display: "flex", 
          alignItems: "center", 
          gap: "4px", 
          color: "var(--color-stone-text)", 
          fontSize: "11px", 
          textTransform: "uppercase", 
          marginTop: "16px",
          fontWeight: 600
        }}
      >
        <span>{expanded ? "Collapse synopsis" : "Expand synopsis"}</span>
        <motion.svg 
          animate={{ rotate: expanded ? 180 : 0 }}
          width="12" 
          height="12" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="3"
        >
          <path d="m6 9 6 6 6-6" />
        </motion.svg>
      </div>

      {/* Expandable synopsis drawer */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ 
              height: "auto", 
              opacity: 1,
              marginTop: 12
            }}
            exit={{ 
              height: 0, 
              opacity: 0,
              marginTop: 0
            }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <div 
              style={{ 
                paddingTop: "16px",
                borderTop: "1px solid rgba(226, 227, 233, 0.06)"
              }}
              onClick={(e) => e.stopPropagation()} // stop parent toggle
            >
              {scene.summaryMd ? (
                <div className="markdown-content">
                  <ReactMarkdown>{scene.summaryMd}</ReactMarkdown>
                </div>
              ) : (
                <div style={{ color: "var(--color-stone-text)" }}>
                  No summary recorded.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </PremiumCard>
  );
}
