import React from "react";
import { motion } from "framer-motion";

interface PremiumCardProps {
  level?: 1 | 2 | 3; // 1 = premium, 2 = default/obsidian, 3 = elevated/highlighted
  hoverEffect?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function PremiumCard({ level = 2, hoverEffect = false, onClick, style, children }: PremiumCardProps) {
  let className = "card";
  if (level === 1) className = "card-premium";
  if (level === 3) className = "card card-elevated";

  const hoverProps = (hoverEffect || onClick) ? {
    whileHover: { 
      y: -2, 
      borderColor: "rgba(174, 147, 87, 0.2)",
      boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(174, 147, 87, 0.04)"
    },
    whileTap: { scale: 0.99 },
    transition: { type: "spring" as const, stiffness: 350, damping: 25 }
  } : {};

  return (
    <motion.div
      className={className}
      onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : "default",
        position: "relative",
        overflow: "hidden",
        ...style
      }}
      {...hoverProps}
    >
      {children}
    </motion.div>
  );
}
