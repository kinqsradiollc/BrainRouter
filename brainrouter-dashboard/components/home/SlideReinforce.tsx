"use client";

import { motion, Variants } from "framer-motion";
import { slideStagger, slideChild } from "./landingData";
import { SlideHeading } from "./SlideHeading";
import { Citation } from "./Citation";
import { FEEDBACK_LOOPS, SOURCES } from "./landingScience";

// Recall-Heat ramp: warm = freshly cited & reinforced, cold = decayed toward archive.
const HOT = "#E0A063";
const COLD = "#3C434B";

const CHIPS = Array.from({ length: 16 }, (_, i) => ({
  i,
  // a deterministic fate so the loop reads clearly: most reinforce, some prune
  pruned: i % 5 === 4,
}));

const reinforceChip: Variants = {
  animate: (i: number) => ({
    backgroundColor: [COLD, HOT, HOT, COLD],
    boxShadow: ["0 0 0 rgba(224,160,99,0)", "0 0 12px rgba(224,160,99,0.6)", "0 0 12px rgba(224,160,99,0.6)", "0 0 0 rgba(224,160,99,0)"],
    scale: [1, 1.12, 1.12, 1],
    transition: { duration: 4, repeat: Infinity, ease: "easeInOut", delay: (i % 5) * 0.3 },
  }),
};

const pruneChip: Variants = {
  animate: (i: number) => ({
    backgroundColor: [HOT, COLD, COLD],
    opacity: [1, 0.22, 0.22],
    scale: [1, 0.82, 0.82],
    transition: { duration: 4.5, repeat: Infinity, ease: "easeInOut", delay: (i % 5) * 0.3 },
  }),
};

/** ACT 5 — consolidation: cited memories are reinforced, unused ones decay. */
export function SlideReinforce() {
  return (
    <motion.section
      variants={slideStagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-90px" }}
      style={{ display: "flex", flexDirection: "column", gap: "28px" }}
    >
      <SlideHeading
        eyebrow="Consolidation"
        title={<>Used memories <span style={{ color: HOT }}>grow</span>. Unused ones <span style={{ color: "var(--text-muted)" }}>fade</span>.</>}
        lede="Like sleep replaying the day to lock in what mattered, BrainRouter consolidates in the background: every cited memory is reinforced, every memory that's surfaced but ignored decays — so the index sharpens instead of bloating."
      />

      {/* Recall-heat field */}
      <motion.div variants={slideChild} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "14px" }}>
        <div
          aria-hidden
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gap: "10px",
            maxWidth: "440px",
            width: "100%",
          }}
        >
          {CHIPS.map((c) => (
            <motion.span
              key={c.i}
              custom={c.i}
              variants={c.pruned ? pruneChip : reinforceChip}
              animate="animate"
              style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: "6px", background: COLD, display: "block" }}
            />
          ))}
        </div>
        {/* heat legend */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>archived</span>
          <span style={{ width: "120px", height: "6px", borderRadius: "3px", background: `linear-gradient(90deg, ${COLD}, ${HOT})` }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", color: HOT }}>cited</span>
        </div>
      </motion.div>

      {/* the two loops, in words */}
      <motion.div
        variants={slideStagger}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}
      >
        {FEEDBACK_LOOPS.map((loop) => {
          const warm = loop.key === "reinforce";
          return (
            <motion.div
              key={loop.key}
              variants={slideChild}
              style={{
                background: "var(--surface-raised)",
                border: `1px solid ${warm ? "rgba(224,160,99,0.4)" : "var(--border-med)"}`,
                borderRadius: "var(--radius-panel)",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.14em", color: warm ? HOT : "var(--text-muted)", fontWeight: 600 }}>{loop.kind}</span>
              <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600, color: "var(--text)" }}>{loop.title}</h3>
              <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.55, color: "var(--text-secondary)" }}>{loop.blurb}</p>
            </motion.div>
          );
        })}
      </motion.div>

      <motion.div variants={slideChild}>
        <Citation sources={[SOURCES.replay]} />
      </motion.div>
    </motion.section>
  );
}
