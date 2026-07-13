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
    whileHover: { borderColor: "rgba(255, 255, 255, 0.18)", ...(props.whileHover as object) },
    whileTap: { opacity: 0.88, ...(props.whileTap as object) },
    transition: { duration: 0.15, ...(props.transition as object) }
  } : {};

  return (
    <motion.div
      className={className}
      onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : "default",
        ...style
      }}
      {...hoverProps}
      {...props}
    >
      {children}
    </motion.div>
  );
}
