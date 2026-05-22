import React from "react";
import { motion } from "framer-motion";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}

export function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="card"
      style={{ 
        padding: "56px 24px", 
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "14px",
        background: "var(--color-obsidian-surface)",
        border: "1px solid rgba(226, 227, 233, 0.04)"
      }}
    >
      {icon && (
        <div style={{ color: "var(--color-stone-text)", display: "flex", justifyContent: "center" }}>
          {icon}
        </div>
      )}
      <h3 className="serif-display" style={{ margin: 0, fontSize: "20px", fontWeight: 400, color: "var(--color-pure-white)" }}>
        {title}
      </h3>
      <p style={{ color: "var(--color-stone-text)", fontSize: "13px", margin: 0, maxWidth: "340px", lineHeight: 1.5 }}>
        {description}
      </p>
      {children}
    </motion.div>
  );
}
