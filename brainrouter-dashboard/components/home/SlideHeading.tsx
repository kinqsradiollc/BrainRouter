"use client";

import { motion } from "framer-motion";
import { slideChild } from "./landingData";

/**
 * Consistent slide heading: a mono eyebrow, a display title, and an optional
 * lede. Renders as a single `slideChild` variant node, so it reveals in step
 * with its parent slide's stagger (do not give it its own whileInView).
 */
export function SlideHeading({
  eyebrow,
  title,
  lede,
  align = "left",
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  align?: "left" | "center";
}) {
  return (
    <motion.div
      variants={slideChild}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        textAlign: align,
        alignItems: align === "center" ? "center" : "flex-start",
        maxWidth: align === "center" ? "720px" : "820px",
        marginLeft: align === "center" ? "auto" : undefined,
        marginRight: align === "center" ? "auto" : undefined,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--accent)",
          fontWeight: 600,
        }}
      >
        {eyebrow}
      </span>
      <h2
        style={{
          fontSize: "clamp(26px, 3vw, 36px)",
          lineHeight: 1.12,
          letterSpacing: "-0.02em",
          fontWeight: 600,
          margin: 0,
          color: "var(--text)",
        }}
      >
        {title}
      </h2>
      {lede && (
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "16px",
            lineHeight: 1.6,
            margin: 0,
            maxWidth: "60ch",
          }}
        >
          {lede}
        </p>
      )}
    </motion.div>
  );
}
