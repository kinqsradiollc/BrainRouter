import React from "react";
import { motion } from "framer-motion";

interface PremiumButtonProps {
  variant?: "primary" | "ghost" | "danger" | "success" | "text";
  size?: "small" | "medium";
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit" | "reset";
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function PremiumButton({ 
  variant = "ghost", 
  size = "medium",
  onClick, 
  disabled = false, 
  title,
  type = "button", 
  style, 
  children 
}: PremiumButtonProps) {
  // Shared base styles
  const baseStyle: React.CSSProperties = {
    fontFamily: "var(--font-inter), sans-serif",
    fontWeight: size === "small" ? 500 : 600,
    fontSize: size === "small" ? "12.5px" : "14px",
    borderRadius: "var(--radius-pill)",
    padding: size === "small" ? "6px 14px" : "10px 24px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: size === "small" ? "4px" : "8px",
    transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
    border: "1px solid transparent",
    outline: "none",
    whiteSpace: "nowrap",
    ...style
  };

  // Variant specific styles
  let variantStyle: React.CSSProperties = {};
  if (variant === "primary") {
    variantStyle = {
      background: "linear-gradient(135deg, #ae9357 0%, #bd9d4f 50%, #d8be7c 100%)",
      color: "#0b0c10",
      border: "1px solid transparent",
      boxShadow: "0 4px 15px rgba(174, 147, 87, 0.25)"
    };
  } else if (variant === "ghost") {
    variantStyle = {
      background: "rgba(174, 147, 87, 0.03)",
      color: "var(--color-golden-accent)",
      border: "1px solid rgba(174, 147, 87, 0.25)",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)"
    };
  } else if (variant === "danger") {
    variantStyle = {
      background: "rgba(239, 68, 68, 0.05)",
      color: "#f87171",
      border: "1px solid rgba(239, 68, 68, 0.25)",
      boxShadow: "0 2px 8px rgba(239, 68, 68, 0.05)"
    };
  } else if (variant === "success") {
    variantStyle = {
      background: "rgba(16, 185, 129, 0.05)",
      color: "#34d399",
      border: "1px solid rgba(16, 185, 129, 0.25)",
      boxShadow: "0 2px 8px rgba(16, 185, 129, 0.05)"
    };
  } else if (variant === "text") {
    variantStyle = {
      background: "var(--overlay-bg)",
      color: "var(--color-stone-text)",
      border: "1px solid var(--border-dim)",
      boxShadow: "var(--card-shadow)"
    };
  }

  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...baseStyle,
        ...variantStyle,
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? "none" : "auto"
      }}
      whileHover={!disabled ? {
        scale: 1.02,
        y: -1,
        boxShadow: variant === "primary" 
          ? "0 6px 20px rgba(174, 147, 87, 0.4)" 
          : (variant === "danger" 
              ? "0 4px 12px rgba(239, 68, 68, 0.15)"
              : (variant === "success"
                  ? "0 4px 12px rgba(16, 185, 129, 0.15)"
                  : "var(--card-shadow-hover)")),
        background: variant === "primary"
          ? "linear-gradient(135deg, #bca166 0%, #cca95c 50%, #e6cb8b 100%)"
          : (variant === "ghost"
              ? "rgba(174, 147, 87, 0.12)"
              : (variant === "danger"
                  ? "rgba(239, 68, 68, 0.15)"
                  : (variant === "success"
                      ? "rgba(16, 185, 129, 0.15)"
                      : "var(--overlay-bg-hover)"))),
        borderColor: variant === "ghost"
          ? "var(--color-golden-accent)"
          : (variant === "danger"
              ? "#ef4444"
              : (variant === "success"
                  ? "#10b981"
                  : (variant === "text"
                      ? "var(--border-strong)"
                      : "transparent"))),
        color: variant === "text"
          ? "var(--color-pure-white)"
          : (variant === "danger"
              ? "#ffffff"
              : (variant === "success"
                  ? "#ffffff"
                  : undefined))
      } : {}}
      whileTap={!disabled ? { scale: 0.98 } : {}}
      transition={{ type: "spring", stiffness: 350, damping: 25 }}
    >
      {children}
    </motion.button>
  );
}
