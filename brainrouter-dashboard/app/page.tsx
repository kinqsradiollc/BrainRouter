"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { PremiumButton } from "../components/PremiumButton";
import { itemVariants, pulseVariants } from "../components/home/landingData";
import { EcosystemSection } from "../components/home/EcosystemSection";
import { HeroGraph } from "../components/home/HeroGraph";
import { STATIC_PRESENTATION } from "../lib/presentation";
import { ScrollBeam } from "../components/home/ScrollBeam";
import { SlideForgetting } from "../components/home/SlideForgetting";
import { SlideHumanMemory } from "../components/home/SlideHumanMemory";
import { SlideMapping } from "../components/home/SlideMapping";
import { SlideRecall } from "../components/home/SlideRecall";
import { SlideReinforce } from "../components/home/SlideReinforce";
import { SlideCli } from "../components/home/SlideCli";

/**
 * Home — a scroll-driven, auto-playing "slide deck" that explains the product
 * grounded in real memory science. The narrative arc:
 *   Hero → the forgetting problem → how human memory works → how BrainRouter
 *   mirrors it (layer for layer) → the recall pipeline → consolidation & decay →
 *   the CLI → the surfaces it runs on → start.
 * Every science claim links its source (see components/home/Slide*). Animations
 * fire on scroll (whileInView) plus continuous ambient loops — no clicks needed.
 */
export default function HomePage() {
  return (
    <>
      <ScrollBeam />
      <div style={{ display: "flex", flexDirection: "column", gap: "72px", paddingBottom: "80px" }}>
        {/* Hero */}
        <motion.section variants={itemVariants} initial="hidden" animate="show" style={{ position: "relative", paddingTop: "8px" }}>
          {/* atmospheric aura behind the hero (subtle, single Signal radial) */}
          <div aria-hidden style={{ position: "absolute", inset: "-60px -80px auto -120px", height: 460, background: "var(--aura-signal)", pointerEvents: "none" }} />

          <div className="hero-grid">
            {/* Left — copy */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "22px", position: "relative" }}>
              <motion.div
                style={{
                  display: "inline-flex", alignItems: "center", gap: "8px",
                  padding: "5px 12px", borderRadius: "var(--radius-pill)",
                  background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)",
                }}
              >
                <motion.span variants={pulseVariants} animate="animate" style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--accent)" }} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 500 }}>
                  Memory-first AI
                </span>
              </motion.div>

              <h1 style={{ fontSize: "clamp(34px, 4vw, 52px)", lineHeight: 1.06, fontWeight: 600, letterSpacing: "-0.03em", margin: 0, maxWidth: "15ch", color: "var(--text)" }}>
                The cognitive memory layer for <span style={{ color: "var(--accent)" }}>autonomous AI agents</span>.
              </h1>

              <p style={{ color: "var(--text-secondary)", fontSize: "17px", lineHeight: 1.6, maxWidth: "50ch", margin: 0 }}>
                BrainRouter turns messy, unstructured chat history into clean, persistent memory — it remembers preferences, self-corrects stale facts, and surfaces the right context on every turn.
              </p>

              <div style={{ display: "flex", gap: "12px", marginTop: "6px", flexWrap: "wrap" }}>
                {!STATIC_PRESENTATION && (
                  <>
                    <Link href="/overview">
                      <PremiumButton variant="primary" style={{ padding: "12px 22px", borderRadius: "10px", fontSize: "14px" }}>
                        <span>Launch dashboard</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: "15px", height: "15px" }}>
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                      </PremiumButton>
                    </Link>
                    <Link href="/memories">
                      <PremiumButton variant="ghost" style={{ padding: "12px 22px", borderRadius: "10px", fontSize: "14px" }}>
                        <span>Inspect memories</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: "15px", height: "15px" }}>
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                      </PremiumButton>
                    </Link>
                  </>
                )}
                <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                  <PremiumButton variant="text" style={{ padding: "12px 18px", borderRadius: "10px", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <svg style={{ width: "16px", height: "16px" }} viewBox="0 0 24 24" fill="currentColor">
                      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span>GitHub</span>
                  </PremiumButton>
                </a>
              </div>
            </div>

            {/* Right — product motif */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
              <HeroGraph />
            </div>
          </div>
        </motion.section>

        {/* The animated, scroll-driven narrative.
            id anchors back the public nav (Memory / CLI / Features). */}
        <SlideForgetting />
        <SlideHumanMemory id="memory" />
        <SlideMapping />
        <SlideRecall />
        <SlideReinforce />
        <SlideCli id="cli" />

        {/* Where it runs — EcosystemSection carries id="features" */}
        <EcosystemSection />

        {/* Closing CTA */}
        <motion.section
          variants={itemVariants}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-90px" }}
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: "20px",
            border: "1px solid var(--border-med)",
            background: "var(--surface-raised)",
            padding: "clamp(32px, 5vw, 64px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "18px",
            textAlign: "center",
          }}
        >
          <div aria-hidden style={{ position: "absolute", inset: "-50% -10% auto -10%", height: 380, background: "var(--aura-signal)", pointerEvents: "none" }} />

          <h2 style={{ position: "relative", fontSize: "clamp(28px, 3.4vw, 42px)", fontWeight: 600, letterSpacing: "-0.02em", margin: 0, maxWidth: "18ch", color: "var(--text)" }}>
            Give your agent a memory that <span style={{ color: "var(--accent)" }}>compounds</span>.
          </h2>
          <p style={{ position: "relative", color: "var(--text-secondary)", fontSize: "16px", lineHeight: 1.6, maxWidth: "54ch", margin: 0 }}>
            Short-term feeds long-term, unused facts fade, cited ones are reinforced — the same loop your mind runs, for every agent you ship.
          </p>
          <div style={{ position: "relative", display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center", marginTop: "6px" }}>
            {!STATIC_PRESENTATION && (
              <Link href="/overview">
                <PremiumButton variant="primary" style={{ padding: "12px 22px", borderRadius: "10px", fontSize: "14px" }}>
                  <span>Launch dashboard</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: "15px", height: "15px" }}>
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </PremiumButton>
              </Link>
            )}
            <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
              <PremiumButton variant={STATIC_PRESENTATION ? "primary" : "ghost"} style={{ padding: "12px 22px", borderRadius: "10px", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
                <svg style={{ width: "16px", height: "16px" }} viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
                </svg>
                <span>View on GitHub</span>
              </PremiumButton>
            </a>
            <Link href="/#memory" style={{ textDecoration: "none" }}>
              <PremiumButton variant="text" style={{ padding: "12px 18px", borderRadius: "10px", fontSize: "14px" }}>
                <span>How it works</span>
              </PremiumButton>
            </Link>
          </div>
        </motion.section>
      </div>
    </>
  );
}
