"use client";

import { motion } from "framer-motion";
import { slideStagger, slideChild } from "./landingData";
import { SlideHeading } from "./SlideHeading";
import { Citation } from "./Citation";
import { RECALL_PIPELINE, SOURCES } from "./landingScience";

/** ACT 4 — recall as a four-stage pipeline (Generative Agents vocabulary). */
export function SlideRecall() {
  return (
    <motion.section
      variants={slideStagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-90px" }}
      style={{ display: "flex", flexDirection: "column", gap: "28px" }}
    >
      <SlideHeading
        eyebrow="Retrieval"
        title={<>Recall is a <span style={{ color: "var(--accent)" }}>four-stage pipeline</span>, not a vector lookup.</>}
        lede="A query doesn't just hit the nearest vectors. It's retrieved three ways, fused and reranked, judged for real relevance, then expanded across the knowledge graph — before a single token reaches the prompt."
      />

      {/* Query → … → Prompt context flow beam */}
      <motion.div variants={slideChild} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Query</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--accent)" }}>Prompt context</span>
        </div>
        <div aria-hidden style={{ position: "relative", height: "3px", borderRadius: "2px", background: "var(--border-med)", overflow: "hidden" }}>
          <motion.div
            style={{ position: "absolute", top: 0, bottom: 0, width: "32%", background: "linear-gradient(90deg, transparent, var(--accent), transparent)" }}
            animate={{ left: ["-32%", "100%"] }}
            transition={{ duration: 2.8, repeat: Infinity, ease: "linear" }}
          />
        </div>
      </motion.div>

      {/* Pipeline stage cards */}
      <motion.div
        variants={slideStagger}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "16px" }}
      >
        {RECALL_PIPELINE.map((stage) => (
          <motion.div
            key={stage.n}
            variants={slideChild}
            style={{
              position: "relative",
              background: "var(--surface-raised)",
              border: "1px solid var(--border-med)",
              borderRadius: "var(--radius-panel)",
              padding: "20px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "26px", fontWeight: 600, color: "var(--accent)", opacity: 0.85, lineHeight: 1 }}>{stage.n}</span>
            <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600, color: "var(--text)" }}>{stage.name}</h3>
            <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.55, color: "var(--text-secondary)" }}>{stage.detail}</p>
          </motion.div>
        ))}
      </motion.div>

      <motion.div variants={slideChild}>
        <Citation sources={[SOURCES.genagents]} />
      </motion.div>
    </motion.section>
  );
}
