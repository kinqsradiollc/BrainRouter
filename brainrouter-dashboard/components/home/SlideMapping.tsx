"use client";

import { motion } from "framer-motion";
import { slideStagger, slideChild } from "./landingData";
import { SlideHeading } from "./SlideHeading";
import { Citation } from "./Citation";
import { MAPPING, SOURCES } from "./landingScience";
import { useIsMobile } from "../../lib/useIsMobile";

/** ACT 3 — the validation: each memory-science store maps to a BrainRouter layer. */
export function SlideMapping() {
  // On phones the 3-column "science → process → layer" grid can't fit the long
  // mono layer names, so each row stacks vertically instead.
  const isMobile = useIsMobile();
  const rowColumns = isMobile ? "1fr" : "1fr 120px 1fr";
  return (
    <motion.section
      variants={slideStagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-90px" }}
      style={{ display: "flex", flexDirection: "column", gap: "28px" }}
    >
      <SlideHeading
        eyebrow="The mapping"
        title={<>BrainRouter mirrors that architecture, <span style={{ color: "var(--accent)" }}>layer for layer</span>.</>}
        lede="Four stores, the same shape as the mind: where each memory lives, which layer owns it, and the process that hands it across."
      />

      {/* Column headers — desktop only; meaningless once the rows stack. */}
      {!isMobile && (
        <motion.div
          variants={slideChild}
          style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr", gap: "14px", alignItems: "center" }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-muted)", textAlign: "right" }}>Human memory</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-muted)", textAlign: "center" }}>Process</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--accent)", textAlign: "left" }}>BrainRouter</span>
        </motion.div>
      )}

      <motion.div variants={slideStagger} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {MAPPING.map((row, i) => (
          <motion.div
            key={row.layer}
            variants={slideChild}
            style={{ display: "grid", gridTemplateColumns: rowColumns, gap: "14px", alignItems: "stretch" }}
          >
            {/* science side */}
            <div
              style={{
                background: "var(--surface-raised)",
                border: "1px solid var(--border-med)",
                borderRadius: "var(--radius-card)",
                padding: "14px 16px",
                textAlign: isMobile ? "center" : "right",
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                justifyContent: "center",
              }}
            >
              <span style={{ fontSize: "15px", fontWeight: 600, color: "var(--text)" }}>{row.sci}</span>
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{row.sciSub}</span>
            </div>

            {/* connector: process chip over a flowing line */}
            <div aria-hidden style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9.5px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--text-secondary)",
                  background: "var(--surface-overlay)",
                  border: "1px solid var(--border-med)",
                  borderRadius: "var(--radius-pill)",
                  padding: "2px 8px",
                  marginBottom: "6px",
                  whiteSpace: "nowrap",
                }}
              >
                {row.process}
              </span>
              <div style={{ position: "relative", width: "100%", height: "2px", background: "var(--border-med)" }}>
                <motion.span
                  style={{ position: "absolute", top: "50%", width: "7px", height: "7px", borderRadius: "50%", background: "var(--accent)", marginTop: "-3.5px", boxShadow: "0 0 10px var(--accent)" }}
                  animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut", times: [0, 0.15, 0.85, 1], delay: i * 0.35 }}
                />
              </div>
            </div>

            {/* BrainRouter side */}
            <div
              style={{
                background: "var(--accent-wash)",
                border: "1px solid var(--border-hover-accent)",
                borderRadius: "var(--radius-card)",
                padding: "14px 16px",
                textAlign: isMobile ? "center" : "left",
                display: "flex",
                flexDirection: "column",
                gap: "3px",
                justifyContent: "center",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 600, color: "var(--accent)", letterSpacing: "-0.01em" }}>{row.layer}</span>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.4 }}>{row.layerSub}</span>
            </div>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={slideChild}>
        <Citation sources={[SOURCES.verywell, SOURCES.genagents, SOURCES.replay]} />
      </motion.div>
    </motion.section>
  );
}
