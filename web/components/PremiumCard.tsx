import React from "react";
import { motion, HTMLMotionProps } from "framer-motion";

interface PremiumCardProps extends HTMLMotionProps<"div"> {
  level?: 1 | 2 | 3; // 1 = premium, 2 = default/obsidian, 3 = elevated/highlighted
  hoverEffect?: boolean;
}

export function PremiumCard({ 
  level = 2, 
  hoverEffect = false, 
  onClick, 
  style, 
  children, 
  className: customClassName,
  ...props 
}: PremiumCardProps) {
  let className = "card";
  if (level === 1) className = "card-premium";
  if (level === 3) className = "card card-elevated";
  if (customClassName) className = `${className} ${customClassName}`;

  const hoverProps = (hoverEffect || onClick) ? {
    whileHover: { 
      y: -2, 
      borderColor: "rgba(174, 147, 87, 0.2)",
      boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(174, 147, 87, 0.04)",
      ...(props.whileHover as any)
    },
    whileTap: { scale: 0.99, ...(props.whileTap as any) },
    transition: { type: "spring" as const, stiffness: 350, damping: 25, ...(props.transition as any) }
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
      {...props}
    >
      {children}
    </motion.div>
  );
}
