"use client";

import { motion, Variants } from "framer-motion";
import { slideStagger, slideChild } from "./landingData";
import { SlideHeading } from "./SlideHeading";
import { CLI_SESSION } from "./landingScience";

const ROLES = [
  { tag: "EXPLORER", desc: "Read-only research" },
  { tag: "ARCHITECT", desc: "Design trade-offs" },
  { tag: "REVIEWER", desc: "Severity-ordered findings" },
  { tag: "WORKER", desc: "Bounded implementation" },
  { tag: "VERIFIER", desc: "Tests & validation" },
];

// Sequence the printed lines so they read like a live session typing itself.
const termStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.6, delayChildren: 0.15 } },
};
const lineFade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.18 } },
};
const typeReveal: Variants = {
  hidden: { clipPath: "inset(0 100% 0 0)" },
  show: { clipPath: "inset(0 0 0 0)", transition: { duration: 0.5, ease: "linear" } },
};

/** ACT 6 — the CLI: the whole brain, driven from a terminal. */
export function SlideCli() {
  return (
    <motion.section
      variants={slideStagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-90px" }}
      style={{ display: "flex", flexDirection: "column", gap: "28px" }}
    >
      <SlideHeading
        eyebrow="The CLI"
        title={<>Drive the whole brain from your <span style={{ color: "var(--accent)" }}>terminal</span>.</>}
        lede="brainrouter is a memory-native coding agent: ~70 slash commands, multi-agent fan-out across five bounded roles, deterministic multi-phase workflows, and a consolidation step that writes what it learned back into the store."
      />

      {/* Terminal window */}
      <motion.div
        variants={slideChild}
        style={{
          background: "#0A0C0E",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
          boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
        }}
      >
        {/* chrome */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "11px 14px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#FF5F57" }} />
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#FEBC2E" }} />
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#28C840" }} />
          <span style={{ marginLeft: "8px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "rgba(255,255,255,0.4)" }}>brainrouter — memory-native agent</span>
        </div>

        {/* body: lines type in on scroll */}
        <motion.div
          variants={termStagger}
          style={{ padding: "18px 20px 20px", fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: 1.5, display: "flex", flexDirection: "column", gap: "10px" }}
        >
          {CLI_SESSION.map((l) => (
            <motion.div key={l.cmd} variants={lineFade} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <div style={{ display: "flex", gap: "8px", whiteSpace: "nowrap", overflow: "hidden" }}>
                <span style={{ color: "var(--accent)", flexShrink: 0 }}>{l.prompt}</span>
                <motion.span variants={typeReveal} style={{ display: "inline-block", whiteSpace: "pre", color: "#E6EAEE" }}>{l.cmd}</motion.span>
              </div>
              {"note" in l && l.note && (
                <span style={{ color: "rgba(255,255,255,0.38)", paddingLeft: "2px" }}>↳ {l.note}</span>
              )}
            </motion.div>
          ))}
          {/* blinking caret */}
          <motion.div variants={lineFade} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={{ color: "var(--accent)" }}>brainrouter ›</span>
            <motion.span
              style={{ display: "inline-block", width: "8px", height: "15px", background: "var(--accent)" }}
              animate={{ opacity: [1, 1, 0, 0] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "linear", times: [0, 0.5, 0.5, 1] }}
            />
          </motion.div>
        </motion.div>
      </motion.div>

      {/* five bounded roles */}
      <motion.div
        variants={slideStagger}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}
      >
        {ROLES.map((r) => (
          <motion.div
            key={r.tag}
            variants={slideChild}
            style={{
              background: "var(--accent-wash)",
              border: "1px solid var(--border-hover-accent)",
              borderRadius: "var(--radius-card)",
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", color: "var(--accent)", fontWeight: 600 }}>{r.tag}</span>
            <span style={{ fontSize: "13px", color: "var(--text)" }}>{r.desc}</span>
          </motion.div>
        ))}
      </motion.div>
    </motion.section>
  );
}
