"use client";

import { motion, Variants } from "framer-motion";
import { slideStagger, slideChild } from "./landingData";
import { SlideHeading } from "./SlideHeading";

const FACTS = ["uses pnpm", "dark theme", "strict TypeScript"];

const driftVariants: Variants = {
  animate: (i: number) => ({
    opacity: [0, 1, 1, 0],
    y: [8, 0, -3, -16],
    transition: {
      duration: 4,
      times: [0, 0.22, 0.62, 1],
      repeat: Infinity,
      ease: "easeInOut",
      delay: i * 0.45,
    },
  }),
};

function SessionCard({
  day,
  state,
  line,
  reply,
  emphasis,
}: {
  day: string;
  state: string;
  line: string;
  reply: string;
  emphasis?: boolean;
}) {
  return (
    <div
      style={{
        flex: "1 1 260px",
        minWidth: 0,
        background: "var(--surface-raised)",
        border: `1px solid ${emphasis ? "var(--border-hover-accent)" : "var(--border-med)"}`,
        borderRadius: "var(--radius-panel)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.1em", color: "var(--text-muted)" }}>{day}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", color: emphasis ? "var(--accent)" : "var(--text-muted)" }}>{state}</span>
      </div>
      <div style={{ alignSelf: "flex-end", maxWidth: "90%", background: "var(--surface-overlay)", border: "1px solid var(--border-med)", borderRadius: "12px 12px 2px 12px", padding: "9px 13px", color: "var(--text)", fontSize: "13px", lineHeight: 1.45 }}>
        {line}
      </div>
      <div style={{ alignSelf: "flex-start", maxWidth: "90%", background: emphasis ? "var(--accent-wash)" : "transparent", border: `1px solid ${emphasis ? "var(--border-hover-accent)" : "var(--border-dim)"}`, borderRadius: "12px 12px 12px 2px", padding: "9px 13px", color: emphasis ? "var(--accent)" : "var(--text-secondary)", fontSize: "13px", lineHeight: 1.45, fontStyle: emphasis ? "normal" : "italic" }}>
        {reply}
      </div>
    </div>
  );
}

/** ACT 1 — the problem: agents forget everything between sessions. */
export function SlideForgetting() {
  return (
    <motion.section
      variants={slideStagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-90px" }}
      style={{ display: "flex", flexDirection: "column", gap: "28px" }}
    >
      <SlideHeading
        eyebrow="The problem"
        title={<>Every session, your agent <span style={{ color: "var(--accent)" }}>starts from zero</span>.</>}
        lede="Dump the whole chat history and you blow the context window. Use a flat vector store and you get whatever is cosine-close, not what's useful. Either way, your agent re-learns the same facts on Monday that it learned on Friday."
      />

      <motion.div
        variants={slideChild}
        style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "stretch", justifyContent: "center" }}
      >
        <SessionCard
          day="MON · SESSION 1"
          state="learns"
          line="I use pnpm, dark theme, strict TS — remember that."
          reply="Got it — noted your setup."
        />

        {/* The void between sessions: the learned facts fade out and evaporate */}
        <div
          aria-hidden
          style={{
            flex: "0 0 170px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            padding: "8px 0",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "center", width: "100%" }}>
            {FACTS.map((f, i) => (
              <motion.span
                key={f}
                custom={i}
                variants={driftVariants}
                animate="animate"
                style={{
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  background: "var(--surface-overlay)",
                  border: "1px solid var(--border-med)",
                  borderRadius: "var(--radius-chip)",
                  padding: "4px 10px",
                }}
              >
                {f}
              </motion.span>
            ))}
          </div>
          <svg width="16" height="22" viewBox="0 0 16 22" fill="none" stroke="var(--text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="2" x2="8" y2="17" />
            <polyline points="3 12 8 17 13 12" />
          </svg>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "9.5px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", textAlign: "center", lineHeight: 1.4 }}>
            session ends ·<br />memory wiped
          </span>
        </div>

        <SessionCard
          day="TUE · SESSION 2"
          state="forgot"
          line="Scaffold the new package for me."
          reply="Sure — which package manager do you use?"
          emphasis
        />
      </motion.div>
    </motion.section>
  );
}
