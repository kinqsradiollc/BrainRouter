"use client";

import { motion, Variants } from "framer-motion";
import Link from "next/link";
import { STATIC_PRESENTATION } from "../../lib/presentation";

const fadeInVariants: Variants = {
  hidden: { opacity: 0, y: 15 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
};

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.15 } }
};

export default function AboutPage() {
  return (
    <div style={{
      maxWidth: "800px",
      margin: "40px auto 80px auto",
      display: "flex",
      flexDirection: "column",
      gap: "48px"
    }}>
      
      {/* Editorial Header */}
      <motion.section 
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        style={{ display: "flex", flexDirection: "column", gap: "16px", textAlign: "center" }}
      >
        <motion.span 
          variants={fadeInVariants}
          style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--color-golden-accent)", fontWeight: 700 }}
        >
          OPEN SOURCE & DECENTRALIZED
        </motion.span>
        <motion.h1 
          variants={fadeInVariants}
          className="serif-display" 
          style={{ fontSize: "42px", margin: 0, fontWeight: 500, lineHeight: 1.1 }}
        >
          Architecting the Future of AI Memory
        </motion.h1>
        <motion.p 
          variants={fadeInVariants}
          style={{ color: "var(--color-stone-text)", fontSize: "16px", maxWidth: "600px", margin: "8px auto 0 auto", lineHeight: 1.6 }}
        >
          We believe cognitive context shouldn't be locked inside proprietary corporate silos. BrainRouter is a secure, persistent long-term memory engine for AI agents that can be hosted in the cloud or run entirely locally.
        </motion.p>
      </motion.section>

      {/* Core Mission Grid */}
      <motion.section 
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}
        className="grid-symmetrical-4"
      >
        <motion.div 
          variants={fadeInVariants}
          className="card-premium"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          <div style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            background: "var(--overlay-bg-hover)",
            border: "1px solid var(--border-hover-accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-golden-accent)"
          }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <h3 className="serif-display" style={{ fontSize: "20px", margin: 0, fontWeight: 500 }}>Absolute Privacy</h3>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", lineHeight: "1.6", margin: 0 }}>
            Your prompts, facts, rules, and contradictory states are saved in a secure, isolated database. No multi-tenant data leaks, no corporate surveillance.
          </p>
        </motion.div>

        <motion.div 
          variants={fadeInVariants}
          className="card-premium"
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          <div style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            background: "var(--overlay-bg-hover)",
            border: "1px solid var(--border-hover-accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-golden-accent)"
          }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16" />
            </svg>
          </div>
          <h3 className="serif-display" style={{ fontSize: "20px", margin: 0, fontWeight: 500 }}>Open Source Forever</h3>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", lineHeight: "1.6", margin: 0 }}>
            The code is fully open-source and MIT licensed. Connect to our hosted engine, or run it as your own local MCP server, build custom hooks, plug it into Next.js, or modify the database adapters. You own your telemetry stack.
          </p>
          <a
            href="https://github.com/kinqsradiollc/BrainRouter"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              color: "var(--color-golden-accent)",
              fontSize: "13px",
              fontWeight: 600,
              textDecoration: "none",
              marginTop: "8px",
              transition: "opacity 0.2s ease"
            }}
            onMouseOver={(e) => e.currentTarget.style.opacity = "0.8"}
            onMouseOut={(e) => e.currentTarget.style.opacity = "1"}
          >
            <span>View Source on GitHub</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="7" y1="17" x2="17" y2="7"></line>
              <polyline points="7 7 17 7 17 17"></polyline>
            </svg>
          </a>
        </motion.div>
      </motion.section>

      {/* What Ships Today */}
      <motion.section
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        style={{ display: "flex", flexDirection: "column", gap: "20px" }}
      >
        <motion.div variants={fadeInVariants} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <span style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--color-golden-accent)", fontWeight: 700 }}>
            WHAT SHIPS TODAY
          </span>
          <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 500 }}>
            One Memory Engine. Three Surfaces.
          </h2>
          <p style={{ color: "var(--color-stone-text)", fontSize: "14px", lineHeight: 1.6, margin: 0 }}>
            BrainRouter is not a single product — it is a cognitive substrate that you can drive from a terminal, a browser, or any MCP-compatible agent. Every surface shares the same memory store, recall pipeline, and contradiction loop.
          </p>
        </motion.div>

        <motion.div
          variants={fadeInVariants}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}
        >
          <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--color-golden-accent)", fontWeight: 700 }}>TERMINAL</span>
            <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, fontWeight: 500 }}>brainrouter CLI</h3>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.55, margin: 0 }}>
              Memory-native coding agent with ~70 slash commands, an LLM-driven compactor, hookify guardrails, and durable per-session transcripts.
            </p>
          </div>

          <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--color-golden-accent)", fontWeight: 700 }}>MULTI-AGENT</span>
            <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, fontWeight: 500 }}>Five Bounded Roles</h3>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.55, margin: 0 }}>
              explorer · architect · reviewer · worker · verifier. Each opens memory-first; large child outputs offload to a working canvas instead of polluting context.
            </p>
          </div>

          <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--color-golden-accent)", fontWeight: 700 }}>BROWSER</span>
            <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, fontWeight: 500 }}>Web Chat & Dashboard</h3>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.55, margin: 0 }}>
              Talk to the agent at <Link href="/chat" style={{ color: "var(--color-golden-accent)" }}>/chat</Link>, inspect recall, scenes, contradictions, evidence, and the knowledge graph — all over the same store.
            </p>
          </div>

          <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--color-golden-accent)", fontWeight: 700 }}>PROTOCOL</span>
            <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, fontWeight: 500 }}>MCP + HTTP API</h3>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.55, margin: 0 }}>
              Plug into any MCP host, or call the HTTP chat-completions route directly — every client inherits the same memory stack.
            </p>
          </div>

          <div className="card-premium" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.1em", color: "var(--color-golden-accent)", fontWeight: 700 }}>MEMORY DEPTH · 0.4.3</span>
            <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, fontWeight: 500 }}>Source-Grounded Recall</h3>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.55, margin: 0 }}>
              Turns are captured as <Link href="/sources" style={{ color: "var(--color-golden-accent)" }}>source chunks</Link>, every memory cites the chunks it was distilled from, and recall drills from a compact hit down to the original source — with a staged blackboard, a summary tree, and a read-only vault mirror behind it.
            </p>
          </div>
        </motion.div>
      </motion.section>

      {/* The Self-Hosting Paradigm */}
      <motion.section 
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        style={{
          background: "var(--color-pewter-accent)",
          border: "1px solid var(--border-med)",
          borderRadius: "16px",
          padding: "40px",
          display: "flex",
          flexDirection: "column",
          gap: "24px"
        }}
      >
        <motion.h2 
          variants={fadeInVariants}
          className="serif-display" 
          style={{ fontSize: "24px", margin: 0, fontWeight: 500 }}
        >
          Why Open Architecture is the Developer Standard
        </motion.h2>
        
        <motion.p 
          variants={fadeInVariants}
          style={{ color: "var(--color-stone-text)", fontSize: "14px", lineHeight: "1.6", margin: 0 }}
        >
          BrainRouter is built on an open, modular architecture. It can bind natively to your local filesystem and workspace directories, or run as a fully-managed cloud node. We host secure cloud relays to seamlessly bridge local and browser-based AI pipelines.
        </motion.p>
        
        {!STATIC_PRESENTATION ? (
          <>
            <motion.p
              variants={fadeInVariants}
              style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6", margin: 0 }}
            >
              To manage your connected instances, track semantic context themes, and monitor contradictions, all you need is a secure <strong style={{ color: "var(--text)", fontWeight: 600 }}>Client API Key</strong>. This key authenticates your local desktop or web-based AI clients to securely interface with your memory core.
            </motion.p>

            <motion.div
              variants={fadeInVariants}
              style={{ paddingTop: "8px" }}
            >
              <Link href="/auth">
                <motion.button
                  className="button-gold"
                  style={{
                    padding: "12px 24px",
                    borderRadius: "var(--radius-pill)",
                    fontWeight: 600,
                    fontSize: "14px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px"
                  }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <span>Get Your Client API Key</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </motion.button>
              </Link>
            </motion.div>
          </>
        ) : (
          <motion.p
            variants={fadeInVariants}
            style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6", margin: 0 }}
          >
            Clone the repository, point it at your own database and model endpoint, and run the MCP server locally — your memory core stays entirely on your machine. No account and no hosted relay required.
          </motion.p>
        )}
      </motion.section>

      {/* Core Maintainer / Contact */}
      <motion.section
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        variants={containerVariants}
        style={{ display: "flex", flexDirection: "column", gap: "20px" }}
      >
        <motion.div variants={fadeInVariants} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <span style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--accent)", fontWeight: 700 }}>
            WHO BUILDS THIS
          </span>
          <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 500 }}>
            Core Maintainer
          </h2>
        </motion.div>

        <motion.div
          variants={fadeInVariants}
          className="card-premium"
          style={{ display: "flex", flexDirection: "column", gap: "20px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div
              aria-hidden
              style={{
                width: "52px",
                height: "52px",
                borderRadius: "50%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--accent-wash)",
                border: "1px solid var(--border-hover-accent)",
                color: "var(--accent)",
                fontWeight: 700,
                fontSize: "18px",
                letterSpacing: "0.02em"
              }}
            >
              AD
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ color: "var(--text)", fontSize: "18px", fontWeight: 600 }}>Anh Dang</span>
              <span style={{ color: "var(--text-secondary)", fontSize: "13px" }}>Creator &amp; core maintainer</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {[
              { kind: "mail", label: "anhdang@brainrouter.dev", href: "mailto:anhdang@brainrouter.dev" },
              { kind: "mail", label: "anhdang@kinqsradio.com", href: "mailto:anhdang@kinqsradio.com" },
              { kind: "linkedin", label: "linkedin.com/in/tran-duc-anh-dang", href: "https://www.linkedin.com/in/tran-duc-anh-dang-392b7a231/" }
            ].map((c) => (
              <a
                key={c.href}
                href={c.href}
                {...(c.kind === "linkedin" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "10px",
                  color: "var(--text-secondary)",
                  fontSize: "14px",
                  textDecoration: "none",
                  transition: "color 0.2s ease",
                  width: "fit-content"
                }}
                onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
                onMouseOut={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
              >
                <span
                  aria-hidden
                  style={{
                    width: "30px",
                    height: "30px",
                    flexShrink: 0,
                    borderRadius: "8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "var(--surface-overlay)",
                    border: "1px solid var(--border-med)",
                    color: "var(--accent)"
                  }}
                >
                  {c.kind === "mail" ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-10 6L2 7" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.64h.05c.53-1 1.83-2.05 3.77-2.05C20.3 8.59 21 10.2 21 13v8h-4v-7.1c0-1.7-.03-3.88-2.37-3.88-2.37 0-2.73 1.85-2.73 3.76V21H9z" />
                    </svg>
                  )}
                </span>
                <span>{c.label}</span>
              </a>
            ))}
          </div>
        </motion.div>
      </motion.section>

    </div>
  );
}
