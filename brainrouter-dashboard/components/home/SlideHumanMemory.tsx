"use client";

import { motion } from "framer-motion";
import { slideStagger, slideChild } from "./landingData";
import { SlideHeading } from "./SlideHeading";
import { Citation } from "./Citation";
import { MEMORY_STAGES, MEMORY_PROCESSES, SOURCES } from "./landingScience";

/** ACT 2 — how human memory actually works: three stores + three processes. */
export function SlideHumanMemory() {
  return (
    <motion.section
      variants={slideStagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-90px" }}
      style={{ display: "flex", flexDirection: "column", gap: "28px" }}
    >
      <SlideHeading
        eyebrow="How memory works"
        title={<>Your brain doesn’t store everything. It <span style={{ color: "var(--accent)" }}>triages</span>.</>}
        lede="Decades of cognitive science describe memory as three stores connected by three processes. Most of what you perceive is dropped within seconds — only what gets rehearsed and consolidated survives."
      />

      {/* Three stores — reveal in sequence, depth deepening left → right */}
      <motion.div
        variants={slideStagger}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "16px" }}
      >
        {MEMORY_STAGES.map((s, i) => (
          <motion.div
            key={s.key}
            variants={slideChild}
            style={{
              position: "relative",
              overflow: "hidden",
              background: "var(--surface-raised)",
              border: "1px solid var(--border-med)",
              borderRadius: "var(--radius-panel)",
              padding: "20px 20px 20px 22px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            {/* depth rail — stronger accent as memory becomes more permanent */}
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: "3px",
                background: "var(--accent)",
                opacity: 0.3 + i * 0.35,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <motion.span
                aria-hidden
                style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--accent)" }}
                animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.25, 1] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: i * 0.4 }}
              />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.14em", color: "var(--text-muted)" }}>{s.tag}</span>
            </div>
            <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 600, color: "var(--text)" }}>{s.name}</h3>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--accent)" }}>{s.duration}</span>
            <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.55, color: "var(--text-secondary)" }}>{s.blurb}</p>
          </motion.div>
        ))}
      </motion.div>

      {/* Three processes — a trace flowing encode → store → retrieve */}
      <motion.div variants={slideChild} style={{ position: "relative", padding: "10px 0 4px" }}>
        <div aria-hidden style={{ position: "absolute", left: "8%", right: "8%", top: "26px", height: "2px", background: "var(--border-med)" }} />
        <motion.span
          aria-hidden
          style={{ position: "absolute", top: "26px", width: "9px", height: "9px", borderRadius: "50%", background: "var(--accent)", marginTop: "-4px", boxShadow: "0 0 12px var(--accent)" }}
          animate={{ left: ["8%", "92%"], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut", times: [0, 0.12, 0.88, 1] }}
        />
        <div style={{ position: "relative", display: "flex", justifyContent: "space-between", gap: "12px" }}>
          {MEMORY_PROCESSES.map((p) => (
            <div key={p.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", textAlign: "center" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                  letterSpacing: "0.06em",
                  color: "var(--text)",
                  background: "var(--surface-overlay)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-pill)",
                  padding: "6px 16px",
                }}
              >
                {p.name}
              </span>
              <span style={{ fontSize: "12px", color: "var(--text-secondary)", maxWidth: "22ch", lineHeight: 1.4 }}>{p.blurb}</span>
            </div>
          ))}
        </div>
      </motion.div>

      <motion.div variants={slideChild}>
        <Citation sources={[SOURCES.verywell]} />
      </motion.div>
    </motion.section>
  );
}
