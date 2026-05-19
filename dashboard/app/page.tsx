"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { PremiumButton } from "../components/PremiumButton";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08
    }
  }
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 25 },
  show: { 
    opacity: 1, 
    y: 0, 
    transition: { type: "spring", stiffness: 220, damping: 22 } 
  }
} as const;

const pulseVariants = {
  animate: {
    scale: [1, 1.04, 1],
    opacity: [0.6, 1, 0.6],
    transition: {
      duration: 2.5,
      repeat: Infinity,
      ease: "easeInOut" as const
    }
  }
};

const hoverScaleVariants = {
  hover: { scale: 1.015, y: -4, transition: { duration: 0.2, ease: "easeOut" as const } }
};

export default function HomePage() {
  return (
    <motion.div
      style={{ display: "flex", flexDirection: "column", gap: "52px", paddingBottom: "60px" }}
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      {/* Premium Hero Section */}
      <motion.section 
        variants={itemVariants}
        style={{ 
          display: "flex", 
          flexDirection: "column", 
          alignItems: "flex-start", 
          gap: "20px", 
          position: "relative",
          paddingTop: "20px"
        }}
      >
        {/* Dynamic Status Badge */}
        <motion.div 
          style={{ 
            display: "inline-flex", 
            alignItems: "center", 
            gap: "8px", 
            padding: "6px 14px", 
            borderRadius: "var(--radius-pill)", 
            background: "rgba(174, 147, 87, 0.08)",
            border: "1px solid rgba(174, 147, 87, 0.25)"
          }}
        >
          <motion.span 
            variants={pulseVariants}
            animate="animate"
            style={{ 
              width: "8px", 
              height: "8px", 
              borderRadius: "50%", 
              background: "rgb(255, 240, 204)",
              boxShadow: "0 0 10px rgb(255, 240, 204)"
            }} 
          />
          <span style={{ fontSize: "12px", letterSpacing: "0.05em", color: "rgb(255, 240, 204)", fontWeight: 500 }}>
            PHASE 3 INTELLIGENCE ENGAGED
          </span>
        </motion.div>

        {/* Serif Authoritative Title */}
        <h1 
          className="serif-display" 
          style={{ 
            fontSize: "64px", 
            lineHeight: 1.05, 
            fontWeight: 400, 
            margin: 0,
            maxWidth: "900px"
          }}
        >
          The Cognitive Memory Layer for <span className="gradient-gold-text">Autonomous AI Assistants</span>.
        </h1>

        {/* Description */}
        <p 
          style={{ 
            color: "var(--color-porcelain-text)", 
            fontSize: "18px", 
            lineHeight: 1.5, 
            maxWidth: "720px", 
            margin: 0,
            letterSpacing: "-0.013px"
          }}
        >
          BrainRouter translates messy, unstructured chat histories into clean, persistent memory. It automatically remembers user preferences, self-corrects outdated guidelines, and keeps your AI personalized, fast, and completely secure.
        </p>

        {/* CTA Button Row */}
        <div style={{ display: "flex", gap: "16px", marginTop: "12px" }}>
          <Link href="/overview">
            <PremiumButton variant="primary" style={{ padding: "14px 28px", borderRadius: "var(--radius-pill)", fontSize: "15px" }}>
              <span>Launch Dashboard Console</span>
              <svg 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2.5" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                style={{ width: "16px", height: "16px" }}
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </PremiumButton>
          </Link>
          <Link href="/memories">
            <PremiumButton variant="ghost" style={{ padding: "14px 28px", borderRadius: "var(--radius-pill)", fontSize: "15px" }}>
              <span>Inspect Active Memories</span>
              <svg 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2.5" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                style={{ width: "16px", height: "16px" }}
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </PremiumButton>
          </Link>
          <a
            href="https://github.com/kinqsradiollc/BrainRouter"
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none" }}
          >
            <PremiumButton variant="text" style={{ padding: "14px 28px", borderRadius: "var(--radius-pill)", fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }}>
              <svg style={{ width: "16px", height: "16px" }} viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
              </svg>
              <span>GitHub</span>
            </PremiumButton>
          </a>
        </div>
      </motion.section>

      {/* Concept Architecture: Three-Tier Hierarchical Model */}
      <motion.section 
        variants={itemVariants}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        <div style={{ borderBottom: "1px solid rgba(226, 227, 233, 0.05)", paddingBottom: "16px" }}>
          <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 500 }}>
            Adaptive Memory Architecture
          </h2>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", margin: 0, marginTop: "4px" }}>
            How BrainRouter transforms temporary conversations into lifetime personalization and context.
          </p>
        </div>

        {/* Tier Layout Grid */}
        <div className="grid-symmetrical-4">
          
          {/* L1 Card */}
          <motion.div 
            className="card-premium" 
            variants={hoverScaleVariants}
            whileHover="hover"
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-ash-text)", fontWeight: 700 }}>LEVEL 01</span>
              <span className="badge" style={{ color: "#bd9d4f", borderColor: "rgba(189,157,79,0.3)", background: "rgba(189,157,79,0.05)" }}>REAL-TIME</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              Session Moments
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Captures important user preferences, instructions, and factual background statements dynamically. It structures raw conversational elements into actionable memory blocks immediately.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(226,227,233,0.04)", fontSize: "12px", color: "var(--color-stone-text)" }}>
              Lifetime: <strong style={{ color: "var(--color-white-frost)" }}>Adaptive 30-Day Half-Life</strong>
            </div>
          </motion.div>

          {/* L1.5 Contradiction Gateway */}
          <motion.div 
            className="card-premium gradient-gold-border" 
            variants={hoverScaleVariants}
            whileHover="hover"
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "rgb(255, 240, 204)", fontWeight: 700 }}>LEVEL 1.5</span>
              <span className="badge" style={{ color: "rgb(255, 240, 204)", borderColor: "rgba(255,240,204,0.3)", background: "rgba(255,240,204,0.05)" }}>AUTOMATIC</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              Self-Correcting Filter
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Maintains user preferences cleanly. If you change a instruction or provide a new habit rule, the system automatically overwrites and heals outdated data to prevent conflicts.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(226,227,233,0.04)", fontSize: "12px", color: "var(--color-stone-text)" }}>
              Core Action: <strong style={{ color: "rgb(255, 240, 204)" }}>Self-Healing Preferences</strong>
            </div>
          </motion.div>

          {/* L2 Card */}
          <motion.div 
            className="card-premium" 
            variants={hoverScaleVariants}
            whileHover="hover"
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-ash-text)", fontWeight: 700 }}>LEVEL 02</span>
              <span className="badge" style={{ color: "#bd9d4f", borderColor: "rgba(189,157,79,0.3)", background: "rgba(189,157,79,0.05)" }}>THEMATIC</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              Memory Themes
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Bridges separate chat sessions by summarizing related memories into overarching project contexts. Keeps track of ongoing topics and interests to preserve structural context across weeks.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(226,227,233,0.04)", fontSize: "12px", color: "var(--color-stone-text)" }}>
              Context Span: <strong style={{ color: "var(--color-white-frost)" }}>Cross-Session Persistence</strong>
            </div>
          </motion.div>

          {/* L3 Card */}
          <motion.div 
            className="card-premium" 
            variants={hoverScaleVariants}
            whileHover="hover"
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-ash-text)", fontWeight: 700 }}>LEVEL 03</span>
              <span className="badge" style={{ color: "#bd9d4f", borderColor: "rgba(189,157,79,0.3)", background: "rgba(189,157,79,0.05)" }}>SYNTHESIS</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              User Persona Profile
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Distills your communication style, primary goals, habits, and decision frameworks into a central profile. This profile anchors your AI's behavior, allowing it to adapt to your personality.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(226,227,233,0.04)", fontSize: "12px", color: "var(--color-stone-text)" }}>
              Access Speed: <strong style={{ color: "var(--color-white-frost)" }}>Instant Prompt Loading</strong>
            </div>
          </motion.div>

        </div>
      </motion.section>

      {/* Direct execution pipeline visualization */}
      <motion.section 
        variants={itemVariants}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        <div style={{ borderBottom: "1px solid rgba(226, 227, 233, 0.05)", paddingBottom: "16px" }}>
          <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 500 }}>
            How a Single Turn Works
          </h2>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", margin: 0, marginTop: "4px" }}>
            The smooth, invisible loop executed during every conversation to keep your AI perfectly aligned.
          </p>
        </div>

        {/* Horizontal Flow Pipeline */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          
          {[
            {
              step: "01",
              title: "Restore and Secure Session",
              desc: "Loads your specific session key and preferences based on your current workspace, ensuring completely private, multi-tenant secure isolation.",
              duration: "Instant Alignment"
            },
            {
              step: "02",
              title: "Context & Relation Retrieval",
              desc: "Simultaneously searches for exact query words and general semantic meanings from your memory timeline, loading the most relevant context for your AI.",
              duration: "Completed in 30ms"
            },
            {
              step: "03",
              title: "Task-Specific Rule Matching",
              desc: "Identifies the current topic and automatically loads specialized checklists and task guidelines matching your precise work scenarios.",
              duration: "Completed in 5ms"
            },
            {
              step: "04",
              title: "Memory Feedback loop",
              desc: "Monitors exactly which memories the AI referenced in its response, strengthening the priority of helpful cards and gently archiving unused ones.",
              duration: "Background Update"
            },
            {
              step: "05",
              title: "Silent Background Saving",
              desc: "Records conversation turns and schedules offline consolidation to keep your memory structures fresh without introducing chat latency.",
              duration: "Non-Blocking Flow"
            }
          ].map((flow, index) => (
            <motion.div 
              key={flow.step}
              className="card"
              variants={hoverScaleVariants}
              whileHover="hover"
              style={{ 
                display: "flex", 
                alignItems: "center", 
                gap: "24px",
                padding: "20px var(--spacing-24)",
                borderLeft: index === 1 ? "3px solid rgb(174, 147, 87)" : "1px solid rgba(226, 227, 233, 0.06)"
              }}
            >
              <div 
                className="serif-display" 
                style={{ 
                  fontSize: "32px", 
                  color: index === 1 ? "rgb(255, 240, 204)" : "var(--color-ash-text)", 
                  fontWeight: 500,
                  minWidth: "40px"
                }}
              >
                {flow.step}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                <h4 style={{ margin: 0, fontSize: "16px", color: "var(--color-pure-white)", fontWeight: 600 }}>
                  {flow.title}
                </h4>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--color-silver-text)", lineHeight: 1.4 }}>
                  {flow.desc}
                </p>
              </div>
              <div style={{ fontSize: "11px", letterSpacing: "0.05em", color: "var(--color-stone-text)", textAlign: "right", minWidth: "160px" }}>
                {flow.duration}
              </div>
            </motion.div>
          ))}

        </div>
      </motion.section>

      {/* Advanced Capabilities Row: Model Routing & Skill Prewarming */}
      <motion.section 
        variants={itemVariants}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: "24px" }}
      >
        {/* Model Routing */}
        <motion.div 
          className="card" 
          variants={hoverScaleVariants}
          whileHover="hover"
          style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "32px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "20px" }}>⚡</span>
            <h3 className="serif-display" style={{ fontSize: "24px", margin: 0, fontWeight: 500 }}>
              Smart Model Routing
            </h3>
          </div>
          <p style={{ color: "var(--color-porcelain-text)", fontSize: "14px", lineHeight: 1.6, margin: 0 }}>
            Not every memory action requires the most expensive AI models. BrainRouter automatically routes simple background tasks and quick checks to cost-effective mini-models, while reserving premium, high-reasoning engines for final complex summaries and persona reports. This cuts API costs drastically while maintaining top cognitive power.
          </p>
          <div 
            style={{ 
              marginTop: "auto", 
              padding: "10px 16px", 
              background: "rgba(174, 147, 87, 0.06)", 
              border: "1px solid rgba(174, 147, 87, 0.15)", 
              borderRadius: "var(--radius-md)",
              display: "flex",
              justifyContent: "space-between",
              fontSize: "13px"
            }}
          >
            <span style={{ color: "var(--color-stone-text)" }}>Average Budget Savings</span>
            <span style={{ color: "rgb(255, 240, 204)", fontWeight: 600 }}>60% – 80% Reduction</span>
          </div>
        </motion.div>

        {/* Skill Pre-Warming */}
        <motion.div 
          className="card" 
          variants={hoverScaleVariants}
          whileHover="hover"
          style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "32px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "20px" }}>❄️</span>
            <h3 className="serif-display" style={{ fontSize: "24px", margin: 0, fontWeight: 500 }}>
              Proactive Memory Pre-Warming
            </h3>
          </div>
          <p style={{ color: "var(--color-porcelain-text)", fontSize: "14px", lineHeight: 1.6, margin: 0 }}>
            No one likes waiting. BrainRouter proactively predicts what files, guidelines, or memories you will need next by analyzing workflow progression patterns. It silently loads and buffers relevant context structures in the background before you even ask, eliminating latency entirely.
          </p>
          <div 
            style={{ 
              marginTop: "auto", 
              padding: "10px 16px", 
              background: "rgba(174, 147, 87, 0.06)", 
              border: "1px solid rgba(174, 147, 87, 0.15)", 
              borderRadius: "var(--radius-md)",
              display: "flex",
              justifyContent: "space-between",
              fontSize: "13px"
            }}
          >
            <span style={{ color: "var(--color-stone-text)" }}>Interaction Overhead</span>
            <span style={{ color: "rgb(255, 240, 204)", fontWeight: 600 }}>0ms Client Latency</span>
          </div>
        </motion.div>
      </motion.section>
    </motion.div>
  );
}
