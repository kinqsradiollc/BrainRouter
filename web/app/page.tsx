"use client";

import Link from "next/link";
import { useState } from "react";
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

const workflowExamples = [
  {
    id: "frontend",
    label: "Frontend Dev",
    request: "\"Generate a new marketing landing page for the enterprise tier.\"",
    l3: { title: "CORE PREFERENCES", detail: "Prefers TailwindCSS code" },
    l2: { title: "ACTIVE SKILL PRE-WARM (L2)", name: "UI-Styling", potential: 3.5, hints: "Always inject Tailwind responsive grids..." },
    l1: { title: "RECENT CONTEXT (L1)", detail: "Discussed 'Obsidian Dark Theme'" },
    execution: "The AI outputs a landing page using Tailwind code in a dark theme. It gets it right on the very first try because BrainRouter provided the exact memory layers and pre-warmed skill rules it needed.",
    feedback: { metric: "What memory was useful?", action: "↑ UI-Styling Spike (+1.0)" },
    distill: { metric: "What new facts happened?", action: "UI-Styling potential refreshed" }
  },
  {
    id: "analyst",
    label: "Data Analyst",
    request: "\"Write a script to visualize the Q3 Revenue data.\"",
    l3: { title: "CORE PREFERENCES", detail: "Prefers Python & Pandas" },
    l2: { title: "ACTIVE SKILL PRE-WARM (L2)", name: "Data-Visualization", potential: 3.2, hints: "Use seaborn, hex #cc9166 for accent curves..." },
    l1: { title: "RECENT CONTEXT (L1)", detail: "Always use Hex #cc9166 in charts" },
    execution: "The AI outputs a perfect Python script using Pandas, and automatically styles the charts using seaborn and the golden hex code, avoiding generic blue defaults.",
    feedback: { metric: "What memory was useful?", action: "↑ Data-Visualization Spike (+1.0)" },
    distill: { metric: "What new facts happened?", action: "Data-Visualization potential refreshed" }
  },
  {
    id: "sales",
    label: "Customer Success",
    request: "\"Draft a reply to this frustrated user about the bug.\"",
    l3: { title: "CORE PREFERENCES", detail: "Empathetic, professional tone" },
    l2: { title: "ACTIVE SKILL PRE-WARM (L2)", name: "Customer-Relations", potential: 3.8, hints: "Include subscription tier & de-escalation checklist..." },
    l1: { title: "RECENT CONTEXT (L1)", detail: "User has been subscribed for 3 years" },
    execution: "The AI writes a highly empathetic email acknowledging their 3-year loyalty on the Enterprise plan, immediately de-escalating the situation without needing manual prompt rewrites.",
    feedback: { metric: "What memory was useful?", action: "↑ Customer-Relations Spike (+1.0)" },
    distill: { metric: "What new facts happened?", action: "Customer-Relations potential refreshed" }
  }
];

export default function HomePage() {
  const [activeExampleId, setActiveExampleId] = useState("frontend");
  const activeExample = workflowExamples.find(ex => ex.id === activeExampleId) || workflowExamples[0];

  // Interactive Mock SNN Simulator State
  const [mockSkills, setMockSkills] = useState([
    { name: "UI-Styling", potential: 0.15, threshold: 0.3, hints: "Always inject Tailwind responsive grids..." },
    { name: "Data-Visualization", potential: 0.25, threshold: 0.3, hints: "Use seaborn, hex #cc9166 for accent curves..." },
    { name: "Customer-Relations", potential: 0.05, threshold: 0.3, hints: "Include subscription tier & de-escalation checklist..." }
  ]);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    "SNN routing potentials initialized.",
    "System listening for active skill tool triggers."
  ]);

  const spikeSkill = (name: string) => {
    setMockSkills(prev => prev.map(skill => {
      if (skill.name === name) {
        const newPotential = Math.min(4.0, skill.potential + 1.2);
        const didCross = newPotential >= 0.3 && skill.potential < 0.3;
        
        setConsoleLogs(logs => [
          ...logs,
          `[SNN SPIKER] Spiked potential for '${name}' by +1.2. New charge: ${newPotential.toFixed(2)}/4.0`,
          ...(didCross ? [`[L2 PREWARM] '${name}' crossed 0.3 threshold! Guidelines now ACTIVE.`] : [])
        ]);
        return { ...skill, potential: newPotential };
      }
      return skill;
    }));
  };

  const decaySkills = () => {
    setMockSkills(prev => prev.map(skill => {
      const newPotential = Math.max(0.0, skill.potential * 0.7);
      const didDeactivate = newPotential < 0.3 && skill.potential >= 0.3;
      
      setConsoleLogs(logs => [
        ...logs,
        `[SNN DECAY] Applied turn decay to potentials.`,
        ...(didDeactivate ? [`[L2 PREWARM] '${skill.name}' potential fell below 0.3. Guidelines DEACTIVATED.`] : [])
      ]);
      return { ...skill, potential: newPotential };
    }));
  };

  const prewarmedSkills = mockSkills.filter(s => s.potential >= 0.3);

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
            background: "var(--overlay-bg-hover)",
            border: "1px solid var(--border-hover-accent)"
          }}
        >
          <motion.span 
            variants={pulseVariants}
            animate="animate"
            style={{ 
              width: "8px", 
              height: "8px", 
              borderRadius: "50%", 
              background: "var(--color-golden-accent)",
              boxShadow: "0 0 10px var(--color-golden-accent)"
            }} 
          />
          <span style={{ fontSize: "12px", letterSpacing: "0.05em", color: "var(--color-golden-accent)", fontWeight: 500 }}>
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

      {/* Live Interactive SNN Simulator Monitor */}
      <motion.section
        variants={itemVariants}
        style={{
          background: "rgba(255, 255, 255, 0.01)",
          border: "1px solid var(--border-med)",
          borderRadius: "16px",
          padding: "28px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          boxShadow: "0 4px 30px rgba(0, 0, 0, 0.2)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-dim)", paddingBottom: "16px" }}>
          <div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, fontWeight: 500, color: "var(--color-pure-white)" }}>
              SNN Skill Pre-Warming Simulator
            </h3>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", margin: "4px 0 0 0" }}>
              Click triggers to spike skill charge potentials, watch decay, and inspect dynamic LLM prompt context injection.
            </p>
          </div>
          <button
            onClick={decaySkills}
            style={{
              padding: "8px 16px",
              borderRadius: "20px",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--color-silver-text)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s ease"
            }}
            onMouseOver={e => {
              e.currentTarget.style.borderColor = "var(--color-golden-accent)";
              e.currentTarget.style.color = "var(--color-pure-white)";
            }}
            onMouseOut={e => {
              e.currentTarget.style.borderColor = "var(--border-strong)";
              e.currentTarget.style.color = "var(--color-silver-text)";
            }}
          >
            ⏳ Apply Turn Decay
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.8fr", gap: "32px" }}>
          {/* Left Panel: Active Routing Potentials & Spikers */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-ash-text)", fontWeight: 700 }}>ACTIVE ROUTING POTENTIALS</span>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {mockSkills.map(skill => {
                const maxPotential = 4.0;
                const percentage = Math.min(100, (skill.potential / maxPotential) * 100);
                const isPrewarmed = skill.potential >= 0.3;
                return (
                  <div 
                    key={skill.name} 
                    style={{ 
                      background: "rgba(255, 255, 255, 0.02)", 
                      border: "1px solid var(--border-dim)", 
                      borderRadius: "10px", 
                      padding: "14px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: "var(--color-pure-white)", fontWeight: 600, fontSize: "14px" }}>{skill.name}</span>
                      <span style={{ 
                        fontSize: "9px", 
                        padding: "2px 6px", 
                        borderRadius: "10px", 
                        background: isPrewarmed ? "rgba(174, 147, 87, 0.15)" : "rgba(255, 255, 255, 0.05)",
                        color: isPrewarmed ? "var(--color-golden-accent)" : "var(--color-stone-text)",
                        border: isPrewarmed ? "1px solid rgba(174, 147, 87, 0.2)" : "1px solid transparent"
                      }}>
                        {isPrewarmed ? "PRE-WARMED" : "DECAYED"}
                      </span>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--color-stone-text)" }}>
                        <span>Charge potential</span>
                        <span>{skill.potential.toFixed(2)} / 4.00</span>
                      </div>
                      <div style={{ width: "100%", height: "4px", background: "rgba(255, 255, 255, 0.05)", borderRadius: "2px", overflow: "hidden" }}>
                        <div style={{ 
                          width: `${percentage}%`, 
                          height: "100%", 
                          background: isPrewarmed ? "var(--color-golden-accent)" : "var(--color-stone-text)",
                          transition: "width 0.3s ease-out"
                        }} />
                      </div>
                    </div>

                    <button
                      onClick={() => spikeSkill(skill.name)}
                      style={{
                        marginTop: "4px",
                        width: "100%",
                        padding: "6px 0",
                        borderRadius: "6px",
                        background: "rgba(174, 147, 87, 0.1)",
                        border: "1px solid rgba(174, 147, 87, 0.2)",
                        color: "var(--color-golden-accent)",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.2s ease"
                      }}
                      onMouseOver={e => {
                        e.currentTarget.style.background = "rgba(174, 147, 87, 0.2)";
                      }}
                      onMouseOut={e => {
                        e.currentTarget.style.background = "rgba(174, 147, 87, 0.1)";
                      }}
                    >
                      ⚡ Spike potential (+1.2)
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Panel: Live Context Preview & Logs */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-ash-text)", fontWeight: 700 }}>LLM SYSTEM CONTEXT INJECTION</span>
            
            <div 
              style={{ 
                background: "var(--surface-pewter-accent)", 
                border: "1px solid var(--border-med)", 
                borderRadius: "10px", 
                padding: "16px",
                fontFamily: "monospace",
                fontSize: "12px",
                color: "var(--color-silver-text)",
                height: "180px",
                overflowY: "auto",
                whiteSpace: "pre-wrap"
              }}
            >
              {prewarmedSkills.length === 0 ? (
                <span style={{ color: "var(--color-stone-text)", fontStyle: "italic" }}>
                  {"<!-- No skills currently pre-warmed. Spike a skill to see context injection -->"}
                </span>
              ) : (
                <span style={{ color: "var(--color-golden-accent)" }}>
                  {`<skill-prewarm>
  Skills detected as currently active — hints pre-loaded:

${prewarmedSkills.map(s => `  [${s.name}] (activation ${s.potential.toFixed(2)})
  ${s.hints}`).join("\n\n---\n\n")}
</skill-prewarm>`}
                </span>
              )}
            </div>

            <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-ash-text)", fontWeight: 700 }}>SIMULATOR CONSOLE LOGS</span>
            <div 
              style={{ 
                background: "#000", 
                border: "1px solid var(--border-dim)", 
                borderRadius: "10px", 
                padding: "12px 16px",
                fontFamily: "monospace",
                fontSize: "11px",
                color: "#10b981",
                height: "100px",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: "4px"
              }}
            >
              {consoleLogs.slice(-6).map((log, i) => (
                <div key={i} style={{ opacity: i === 5 ? 1 : 0.65 }}>
                  {log}
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.section>

      {/* Concept Architecture: Three-Tier Hierarchical Model */}
      <motion.section 
        variants={itemVariants}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        <div style={{ borderBottom: "1px solid var(--border-dim)", paddingBottom: "16px" }}>
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
              <span className="badge" style={{ color: "var(--color-golden-accent)", borderColor: "var(--border-hover-accent)", background: "var(--overlay-bg-hover)" }}>REAL-TIME</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              Session Moments
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Captures important user preferences, instructions, and factual background statements dynamically. It structures raw conversational elements into actionable memory blocks immediately.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--border-dim)", fontSize: "12px", color: "var(--color-stone-text)" }}>
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
              <span style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-golden-accent)", fontWeight: 700 }}>LEVEL 1.5</span>
              <span className="badge" style={{ color: "var(--color-golden-accent)", borderColor: "var(--border-hover-accent)", background: "var(--overlay-bg-hover)" }}>AUTOMATIC</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              Self-Correcting Filter
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Maintains user preferences cleanly. If you change a instruction or provide a new habit rule, the system automatically overwrites and heals outdated data to prevent conflicts.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--border-dim)", fontSize: "12px", color: "var(--color-stone-text)" }}>
              Core Action: <strong style={{ color: "var(--color-golden-accent)" }}>Self-Healing Preferences</strong>
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
              <span className="badge" style={{ color: "var(--color-golden-accent)", borderColor: "var(--border-hover-accent)", background: "var(--overlay-bg-hover)" }}>THEMATIC</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              Memory Themes
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Bridges separate chat sessions by summarizing related memories into overarching project contexts. Keeps track of ongoing topics and interests to preserve structural context across weeks.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--border-dim)", fontSize: "12px", color: "var(--color-stone-text)" }}>
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
              <span className="badge" style={{ color: "var(--color-golden-accent)", borderColor: "var(--border-hover-accent)", background: "var(--overlay-bg-hover)" }}>SYNTHESIS</span>
            </div>
            <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-pure-white)" }}>
              User Persona Profile
            </h3>
            <p style={{ color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Distills your communication style, primary goals, habits, and decision frameworks into a central profile. This profile anchors your AI's behavior, allowing it to adapt to your personality.
            </p>
            <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--border-dim)", fontSize: "12px", color: "var(--color-stone-text)" }}>
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
        <div style={{ borderBottom: "1px solid var(--border-dim)", paddingBottom: "16px" }}>
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
              duration: "Highly Responsive Search"
            },
            {
              step: "03",
              title: "Task-Specific Rule Matching",
              desc: "Identifies the current topic and automatically loads specialized checklists and task guidelines matching your precise work scenarios.",
              duration: "Fast Context Assembly"
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
                borderLeft: index === 1 ? "3px solid var(--color-golden-accent)" : "1px solid var(--border-dim)"
              }}
            >
              <div 
                className="serif-display" 
                style={{ 
                  fontSize: "32px", 
                  color: index === 1 ? "var(--color-golden-accent)" : "var(--color-ash-text)", 
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

      {/* Full Agent Workflow: Flowchart Layout */}
      <motion.section 
        variants={itemVariants}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        <div style={{ borderBottom: "1px solid var(--border-dim)", paddingBottom: "16px" }}>
          <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 500 }}>
            The Full Agent Workflow
          </h2>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", margin: 0, marginTop: "4px" }}>
            See exactly how an autonomous agent leverages BrainRouter to deliver perfectly personalized results in a single turn.
          </p>
        </div>

        {/* Example Selector */}
        <div style={{ display: "flex", justifyContent: "center", gap: "12px", marginTop: "8px" }}>
          {workflowExamples.map(ex => (
            <button
              key={ex.id}
              onClick={() => setActiveExampleId(ex.id)}
              style={{
                background: activeExampleId === ex.id ? "var(--color-pure-white)" : "transparent",
                color: activeExampleId === ex.id ? "var(--color-midnight-ink)" : "var(--color-stone-text)",
                border: `1px solid ${activeExampleId === ex.id ? "var(--color-pure-white)" : "var(--border-strong)"}`,
                padding: "8px 16px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.2s ease"
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>

        <motion.div 
          key={activeExampleId}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={{
            hidden: { opacity: 0 },
            visible: {
              opacity: 1,
              transition: { staggerChildren: 0.8 }
            }
          }}
          style={{ 
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "40px 0",
            maxWidth: "760px",
            margin: "0 auto",
            width: "100%"
          }}
        >
          {/* Block 1: User Request */}
          <motion.div 
            className="card"
            variants={{
              hidden: { opacity: 0, y: 20 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
            }}
            style={{ 
              background: "var(--surface-pewter-accent)", 
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              width: "100%",
              maxWidth: "500px",
              border: "1px solid var(--border-med)",
              boxShadow: "0 8px 30px var(--overlay-bg)",
              textAlign: "center"
            }}
          >
            <div style={{ color: "var(--color-silver-text)", fontSize: "12px", fontWeight: 600, letterSpacing: "0.05em" }}>
              USER REQUEST
            </div>
            <p style={{ margin: 0, color: "var(--color-pure-white)", fontSize: "16px", lineHeight: 1.5, fontFamily: "var(--font-inter)" }}>
              {activeExample.request}
            </p>
          </motion.div>

          {/* Animated Arrow 1 */}
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <svg width="24" height="40" viewBox="0 0 24 40" fill="none">
              <line x1="12" y1="0" x2="12" y2="30" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
              <motion.line 
                x1="12" y1="0" x2="12" y2="30" 
                stroke="var(--color-golden-accent)" 
                strokeWidth="2" 
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, times: [0, 0.6, 1], ease: "easeInOut", delay: 0 }}
              />
              <path d="M6 24 L12 30 L18 24" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <motion.path 
                d="M6 24 L12 30 L18 24" 
                stroke="var(--color-golden-accent)" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0, 1, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, times: [0, 0.5, 0.6, 1], ease: "easeInOut", delay: 0 }}
              />
            </svg>
          </div>

          {/* Block 2: Agent & Memory Dual Node */}
          <motion.div 
            variants={{
              hidden: { opacity: 0, y: 20 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
            }}
            style={{ 
              display: "grid", 
              gridTemplateColumns: "1fr 1fr", 
              gap: "24px",
              width: "100%",
              position: "relative"
            }}
          >
            {/* Horizontal Connection line between Agent and Memory */}
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "40px", zIndex: 0, display: "flex", justifyContent: "center" }}>
              <svg width="40" height="24" viewBox="0 0 40 24" fill="none">
                <line x1="0" y1="12" x2="40" y2="12" stroke="var(--border-strong)" strokeWidth="2" strokeDasharray="4 4" />
                <motion.circle cx="20" cy="12" r="4" fill="var(--color-golden-accent)" 
                  animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }} 
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }} 
                />
              </svg>
            </div>

            {/* Agent Node */}
            <div className="card" style={{ background: "var(--surface-pewter-accent)", padding: "20px", display: "flex", flexDirection: "column", gap: "12px", border: "1px solid var(--border-med)", boxShadow: "0 8px 30px var(--overlay-bg)", zIndex: 1 }}>
              <div style={{ color: "var(--color-silver-text)", fontSize: "12px", fontWeight: 600, letterSpacing: "0.05em", textAlign: "center" }}>
                AI AGENT
              </div>
              <p style={{ margin: 0, color: "var(--color-silver-text)", fontSize: "13px", lineHeight: 1.4, textAlign: "center" }}>
                The AI starts processing the request, but first, it asks BrainRouter for context about this specific user.
              </p>
            </div>

            {/* Memory Node */}
            <div className="card" style={{ background: "var(--surface-slate-gray)", padding: "20px", display: "flex", flexDirection: "column", gap: "12px", border: "1px solid var(--border-hover-accent)", boxShadow: "var(--card-shadow-hover)", zIndex: 1 }}>
              <div style={{ color: "var(--color-golden-accent)", fontSize: "12px", fontWeight: 700, letterSpacing: "0.05em", textAlign: "center" }}>
                BRAINROUTER INSTANT RECALL
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {/* L3 Persona */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", background: "var(--overlay-bg)", padding: "10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)" }}>
                  <span style={{ background: "var(--color-golden-accent)", color: "#000", padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: 700 }}>L3</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ color: "var(--color-stone-text)", fontSize: "10px", fontWeight: 600 }}>{activeExample.l3.title}</span>
                    <span style={{ color: "var(--color-white-frost)", fontSize: "12px", fontFamily: "var(--font-inter)" }}>{activeExample.l3.detail}</span>
                  </div>
                </div>

                {/* L2 Pre-warm */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", background: "var(--overlay-bg)", padding: "10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)" }}>
                  <span style={{ background: "#4f46e5", color: "#fff", padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: 700 }}>L2</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: "var(--color-stone-text)", fontSize: "10px", fontWeight: 600 }}>{activeExample.l2.title}</span>
                      <span style={{ color: "var(--color-golden-accent)", fontSize: "10px", fontWeight: 700 }}>{activeExample.l2.name}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span style={{ color: "var(--color-white-frost)", fontSize: "11px", fontStyle: "italic" }}>"{activeExample.l2.hints}"</span>
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "2px" }}>
                        <div style={{ flex: 1, height: "3px", background: "rgba(255,255,255,0.08)", borderRadius: "2px", overflow: "hidden" }}>
                          <div style={{ width: `${(activeExample.l2.potential / 4.0) * 100}%`, height: "100%", background: "var(--color-golden-accent)" }} />
                        </div>
                        <span style={{ color: "var(--color-ash-text)", fontSize: "9px" }}>{activeExample.l2.potential.toFixed(1)}/4.0</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* L1 Context */}
                <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", background: "var(--overlay-bg)", padding: "10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)" }}>
                  <span style={{ background: "var(--color-silver-text)", color: "#000", padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: 700 }}>L1</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ color: "var(--color-stone-text)", fontSize: "10px", fontWeight: 600 }}>{activeExample.l1.title}</span>
                    <span style={{ color: "var(--color-white-frost)", fontSize: "12px", fontFamily: "var(--font-inter)" }}>{activeExample.l1.detail}</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Animated Arrow 2 */}
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <svg width="24" height="40" viewBox="0 0 24 40" fill="none">
              <line x1="12" y1="0" x2="12" y2="30" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
              <motion.line 
                x1="12" y1="0" x2="12" y2="30" 
                stroke="var(--color-golden-accent)" 
                strokeWidth="2" 
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, times: [0, 0.6, 1], ease: "easeInOut", delay: 0.5 }}
              />
              <path d="M6 24 L12 30 L18 24" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <motion.path 
                d="M6 24 L12 30 L18 24" 
                stroke="var(--color-golden-accent)" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0, 1, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, times: [0, 0.5, 0.6, 1], ease: "easeInOut", delay: 0.5 }}
              />
            </svg>
          </div>

          {/* Block 3: Agent Execution */}
          <motion.div 
            className="card"
            variants={{
              hidden: { opacity: 0, y: 20 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
            }}
            style={{ 
              background: "var(--surface-pewter-accent)", 
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              width: "100%",
              maxWidth: "600px",
              border: "1px solid var(--border-med)",
              boxShadow: "0 8px 30px var(--overlay-bg)",
              textAlign: "center"
            }}
          >
            <div style={{ color: "var(--color-white-frost)", fontSize: "12px", fontWeight: 600, letterSpacing: "0.05em" }}>
              PERFECT RESPONSE (NO BACK-AND-FORTH)
            </div>
            <p style={{ margin: 0, color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, fontFamily: "var(--font-inter)" }}>
              {activeExample.execution}
            </p>
          </motion.div>

          {/* Animated Arrow 3 */}
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <svg width="24" height="40" viewBox="0 0 24 40" fill="none">
              <line x1="12" y1="0" x2="12" y2="30" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
              <motion.line 
                x1="12" y1="0" x2="12" y2="30" 
                stroke="var(--color-golden-accent)" 
                strokeWidth="2" 
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, times: [0, 0.6, 1], ease: "easeInOut", delay: 1.0 }}
              />
              <path d="M6 24 L12 30 L18 24" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <motion.path 
                d="M6 24 L12 30 L18 24" 
                stroke="var(--color-golden-accent)" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0, 1, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, times: [0, 0.5, 0.6, 1], ease: "easeInOut", delay: 1.0 }}
              />
            </svg>
          </div>

          {/* Block 4: Distillation & Feedback */}
          <motion.div 
            className="card"
            variants={{
              hidden: { opacity: 0, y: 20 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
            }}
            style={{ 
              background: "var(--surface-slate-gray)", 
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              width: "100%",
              maxWidth: "600px",
              border: "1px solid var(--border-strong)",
              boxShadow: "0 8px 30px var(--overlay-bg)",
              textAlign: "center"
            }}
          >
            <div style={{ color: "var(--color-white-frost)", fontSize: "12px", fontWeight: 700, letterSpacing: "0.08em" }}>
              BACKGROUND LEARNING LOOP
            </div>
            
            <p style={{ margin: 0, color: "var(--color-silver-text)", fontSize: "14px", lineHeight: 1.5, fontFamily: "var(--font-inter)" }}>
              After the response, BrainRouter silently works in the background to learn for next time.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", textAlign: "left" }}>
              <div style={{ background: "var(--overlay-bg)", padding: "12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)", display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ color: "var(--color-stone-text)", fontSize: "11px", display: "block" }}>{activeExample.feedback.metric}</span>
                <span style={{ color: "var(--color-golden-accent)", fontSize: "13px", fontWeight: 600 }}>{activeExample.feedback.action}</span>
              </div>
              <div style={{ background: "var(--overlay-bg)", padding: "12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)", display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ color: "var(--color-stone-text)", fontSize: "11px", display: "block" }}>{activeExample.distill.metric}</span>
                <span style={{ color: "var(--color-white-frost)", fontSize: "13px", fontWeight: 500 }}>{activeExample.distill.action}</span>
              </div>
            </div>
          </motion.div>

        </motion.div>
      </motion.section>

      {/* Ecosystem Architecture */}
      <motion.section 
        variants={itemVariants}
        style={{ display: "flex", flexDirection: "column", gap: "28px", marginTop: "40px", marginBottom: "40px" }}
      >
        <div style={{ borderBottom: "1px solid var(--border-dim)", paddingBottom: "16px" }}>
          <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 500 }}>
            The Omnichannel Brain
          </h2>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", margin: 0, marginTop: "4px" }}>
            BrainRouter syncs state, memory, skills, and persona across your entire device ecosystem and workflow architecture in real-time.
          </p>
        </div>

        <motion.div 
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-100px" }}
          variants={{
            hidden: { opacity: 0 },
            visible: { opacity: 1, transition: { staggerChildren: 0.2 } }
          }}
          style={{ 
            position: "relative",
            width: "100%",
            maxWidth: "900px",
            margin: "40px auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0"
          }}
        >
          {/* Top Row: Autonomous Cloud & Desktop IDE */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "200px", width: "100%", maxWidth: "700px", zIndex: 2 }}>
            <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="card" style={{ background: "var(--surface-pewter-accent)", padding: "20px", border: "1px solid var(--border-med)", boxShadow: "0 8px 30px var(--overlay-bg)", textAlign: "center" }}>
              <div style={{ fontSize: "20px", marginBottom: "8px" }}>🤖</div>
              <div style={{ color: "var(--color-pure-white)", fontSize: "13px", fontWeight: 600 }}>Cloud Workflows</div>
              <div style={{ color: "var(--color-stone-text)", fontSize: "12px", marginTop: "4px" }}>Background Agents & Scheduled Skill Distillation</div>
            </motion.div>
            
            <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="card" style={{ background: "var(--surface-pewter-accent)", padding: "20px", border: "1px solid var(--border-med)", boxShadow: "0 8px 30px var(--overlay-bg)", textAlign: "center" }}>
              <div style={{ fontSize: "20px", marginBottom: "8px" }}>🖥️</div>
              <div style={{ color: "var(--color-pure-white)", fontSize: "13px", fontWeight: 600 }}>Desktop IDEs</div>
              <div style={{ color: "var(--color-stone-text)", fontSize: "12px", marginTop: "4px" }}>VS Code, Cursor & Local Skill Pre-Warming</div>
            </motion.div>
          </div>

          {/* SVG Connecting Lines (Top to Center) */}
          <div style={{ position: "relative", width: "100%", height: "80px", zIndex: 1, marginTop: "-20px", marginBottom: "-20px" }}>
            <svg width="100%" height="100%" preserveAspectRatio="none">
              {/* Left Line */}
              <path d="M 250 0 C 250 60, 450 20, 450 80" stroke="var(--border-strong)" strokeWidth="2" fill="none" strokeDasharray="4 4" />
              <motion.path d="M 250 0 C 250 60, 450 20, 450 80" stroke="var(--color-golden-accent)" strokeWidth="3" fill="none"
                initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }} transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
              />
              {/* Right Line */}
              <path d="M 650 0 C 650 60, 450 20, 450 80" stroke="var(--border-strong)" strokeWidth="2" fill="none" strokeDasharray="4 4" />
              <motion.path d="M 650 0 C 650 60, 450 20, 450 80" stroke="var(--color-golden-accent)" strokeWidth="3" fill="none"
                initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }} transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.6 }}
              />
            </svg>
          </div>

          {/* Center Hub: BrainRouter Internal Architecture */}
          <motion.div variants={{ hidden: { opacity: 0, scale: 0.95 }, visible: { opacity: 1, scale: 1 } }} style={{ zIndex: 3, position: "relative", width: "100%", maxWidth: "680px" }}>
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "250px", height: "250px", borderRadius: "50%", background: "var(--color-golden-accent)", opacity: 0.08, filter: "blur(40px)", animation: "pulse 6s infinite" }} />
            
            <div className="card" style={{ background: "var(--surface-slate-gray)", padding: "28px", border: "1px solid var(--border-hover-accent)", boxShadow: "var(--card-shadow)", width: "100%", display: "flex", flexDirection: "column", gap: "20px" }}>
              
              {/* Header */}
              <div style={{ textAlign: "center" }}>
                <span style={{ background: "var(--border-hover-accent)", color: "var(--color-golden-accent)", padding: "4px 12px", borderRadius: "12px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  INTERNAL SUBSYSTEMS
                </span>
                <h3 className="serif-display" style={{ color: "var(--color-pure-white)", fontSize: "22px", margin: "8px 0 4px 0", fontWeight: 500 }}>
                  BrainRouter Architecture
                </h3>
                <p style={{ color: "var(--color-silver-text)", fontSize: "12px", margin: 0 }}>
                  Real-time cognitive routing, memory distillation & semantic retrieval pipeline.
                </p>
              </div>

              {/* 1. Ingestion / API Gateway */}
              <div style={{ background: "var(--overlay-bg)", padding: "14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)" }}>
                <div style={{ color: "var(--color-white-frost)", fontSize: "11px", fontWeight: 700, marginBottom: "8px", letterSpacing: "0.05em" }}>
                  1. DYNAMIC TRANSPORT GATEWAY
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <div style={{ background: "var(--border-dim)", padding: "8px 10px", borderRadius: "4px", fontSize: "11px", border: "1px solid var(--border-dim)" }}>
                    <span style={{ color: "var(--color-pure-white)", fontWeight: 600, display: "block" }}>Stdio Multiplexer</span>
                    <span style={{ color: "var(--color-stone-text)" }}>Local editor pipe (VS Code / CLI)</span>
                  </div>
                  <div style={{ background: "var(--border-dim)", padding: "8px 10px", borderRadius: "4px", fontSize: "11px", border: "1px solid var(--border-dim)" }}>
                    <span style={{ color: "var(--color-pure-white)", fontWeight: 600, display: "block" }}>Streamable HTTP (SSE)</span>
                    <span style={{ color: "var(--color-stone-text)" }}>Remote agent server integrations</span>
                  </div>
                </div>
              </div>

              {/* 2. Processing Pipelines */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                
                {/* Cognitive Extraction & Consolidation */}
                <div style={{ background: "var(--overlay-bg)", padding: "14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ color: "var(--color-white-frost)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.05em" }}>
                    2. COGNITIVE PIPELINE
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "11px" }}>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>L1 Extractor & Dedup</span>
                      <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>Memory Clean</span>
                    </div>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>L1 Contradiction Auditor</span>
                      <span style={{ color: "#ff6b6b", fontWeight: 500 }}>Conflict Check</span>
                    </div>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>L2 Director & Skill Prewarm</span>
                      <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>Tool Routing</span>
                    </div>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>L3 Cognitive Distiller</span>
                      <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>Consolidator</span>
                    </div>
                  </div>
                </div>

                {/* Graph & Semantics */}
                <div style={{ background: "var(--overlay-bg)", padding: "14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ color: "var(--color-white-frost)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.05em" }}>
                    3. RELATIONSHIP ENGINE
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "11px" }}>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>Graph Builder & Recall</span>
                      <span style={{ color: "var(--color-stone-text)" }}>Build Nodes</span>
                    </div>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>Hybrid Reranker (BM25)</span>
                      <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>Semantic</span>
                    </div>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>ACE Feedback Loop</span>
                      <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>Citation Weight</span>
                    </div>
                    <div style={{ background: "var(--border-dim)", padding: "5px 8px", borderRadius: "4px", display: "flex", justifyContent: "space-between", border: "1px solid var(--border-dim)" }}>
                      <span style={{ color: "var(--color-pure-white)" }}>Scheduler & Working Context</span>
                      <span style={{ color: "var(--color-golden-accent)", fontWeight: 500 }}>Offload</span>
                    </div>
                  </div>
                </div>

              </div>

              {/* 3. Storage Layer */}
              <div style={{ background: "var(--overlay-bg)", padding: "14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-dim)" }}>
                <div style={{ color: "var(--color-white-frost)", fontSize: "11px", fontWeight: 700, marginBottom: "8px", letterSpacing: "0.05em" }}>
                  4. ISOLATED MULTI-TENANT STORAGE LAYER
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.8fr", gap: "12px", alignItems: "center" }}>
                   <div style={{ background: "var(--surface-pewter-accent)", padding: "10px", borderRadius: "4px", textAlign: "center", border: "1px solid var(--border-hover-accent)" }}>
                    <div style={{ color: "var(--color-golden-accent)", fontWeight: 700, fontSize: "11px" }}>PLUGGABLE DB ADAPTER</div>
                    <div style={{ color: "var(--color-pure-white)", fontSize: "9px", marginTop: "4px", fontWeight: 500 }}>SQLite <span style={{ color: "var(--color-stone-text)" }}>|</span> Postgres <span style={{ color: "var(--color-stone-text)" }}>|</span> Vector</div>
                    <div style={{ color: "var(--color-stone-text)", fontSize: "8px", marginTop: "2px" }}>Tenant-Isolated Storage</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px" }}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <span style={{ background: "var(--border-med)", color: "var(--color-pure-white)", padding: "1px 4px", borderRadius: "2px", fontSize: "9px", fontWeight: 700 }}>L1</span>
                      <span style={{ color: "var(--color-silver-text)" }}>Short-Term Context & Task State</span>
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <span style={{ background: "var(--border-med)", color: "var(--color-pure-white)", padding: "1px 4px", borderRadius: "2px", fontSize: "9px", fontWeight: 700 }}>L2</span>
                      <span style={{ color: "var(--color-silver-text)" }}>Procedural Skills & Tools Registry</span>
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <span style={{ background: "rgba(204, 145, 102, 0.15)", color: "var(--color-golden-accent)", padding: "1px 4px", borderRadius: "2px", fontSize: "9px", fontWeight: 700 }}>L3</span>
                      <span style={{ color: "var(--color-silver-text)" }}>Core Persona & Custom Constraints</span>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </motion.div>

          {/* SVG Connecting Lines (Center to Bottom) */}
          <div style={{ position: "relative", width: "100%", height: "80px", zIndex: 1, marginTop: "-20px", marginBottom: "-20px" }}>
            <svg width="100%" height="100%" preserveAspectRatio="none">
              {/* Left Line */}
              <path d="M 450 0 C 450 60, 250 20, 250 80" stroke="var(--border-strong)" strokeWidth="2" fill="none" strokeDasharray="4 4" />
              <motion.path d="M 450 0 C 450 60, 250 20, 250 80" stroke="var(--color-golden-accent)" strokeWidth="3" fill="none"
                initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }} transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 1.0 }}
              />
              {/* Right Line */}
              <path d="M 450 0 C 450 60, 650 20, 650 80" stroke="var(--border-strong)" strokeWidth="2" fill="none" strokeDasharray="4 4" />
              <motion.path d="M 450 0 C 450 60, 650 20, 650 80" stroke="var(--color-golden-accent)" strokeWidth="3" fill="none"
                initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: [0, 1, 1], opacity: [0, 1, 0] }} transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 1.4 }}
              />
            </svg>
          </div>

          {/* Bottom Row: CLI & Mobile Apps */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "200px", width: "100%", maxWidth: "700px", zIndex: 2 }}>
            <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="card" style={{ background: "var(--surface-pewter-accent)", padding: "20px", border: "1px solid var(--border-med)", boxShadow: "0 8px 30px var(--overlay-bg)", textAlign: "center" }}>
              <div style={{ fontSize: "20px", marginBottom: "8px" }}>⌨️</div>
              <div style={{ color: "var(--color-pure-white)", fontSize: "13px", fontWeight: 600 }}>CLI & Scripts</div>
              <div style={{ color: "var(--color-stone-text)", fontSize: "12px", marginTop: "4px" }}>Headless Workflows & Manual Skill Spikes</div>
            </motion.div>
            
            <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="card" style={{ background: "var(--surface-pewter-accent)", padding: "20px", border: "1px solid var(--border-med)", boxShadow: "0 8px 30px var(--overlay-bg)", textAlign: "center" }}>
              <div style={{ fontSize: "20px", marginBottom: "8px" }}>📱</div>
              <div style={{ color: "var(--color-pure-white)", fontSize: "13px", fontWeight: 600 }}>Mobile Clients</div>
              <div style={{ color: "var(--color-stone-text)", fontSize: "12px", marginTop: "4px" }}>iOS / Android Apps & Cross-Device Skill Sync</div>
            </motion.div>
          </div>

        </motion.div>
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
              background: "var(--overlay-bg-hover)", 
              border: "1px solid var(--border-hover-accent)", 
              borderRadius: "var(--radius-md)",
              display: "flex",
              justifyContent: "space-between",
              fontSize: "13px"
            }}
          >
            <span style={{ color: "var(--color-stone-text)" }}>Average Budget Savings</span>
            <span style={{ color: "var(--color-golden-accent)", fontWeight: 600 }}>Significant Token Savings</span>
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
              background: "var(--overlay-bg-hover)", 
              border: "1px solid var(--border-hover-accent)", 
              borderRadius: "var(--radius-md)",
              display: "flex",
              justifyContent: "space-between",
              fontSize: "13px"
            }}
          >
            <span style={{ color: "var(--color-stone-text)" }}>Interaction Overhead</span>
            <span style={{ color: "var(--color-golden-accent)", fontWeight: 600 }}>Zero Client Latency</span>
          </div>
        </motion.div>
      </motion.section>
    </motion.div>
  );
}
