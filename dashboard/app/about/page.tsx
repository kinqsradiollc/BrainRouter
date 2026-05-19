"use client";

import { motion, Variants } from "framer-motion";
import Link from "next/link";

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
            background: "rgba(174, 147, 87, 0.08)",
            border: "1px solid rgba(174, 147, 87, 0.2)",
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
            background: "rgba(174, 147, 87, 0.08)",
            border: "1px solid rgba(174, 147, 87, 0.2)",
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

      {/* The Self-Hosting Paradigm */}
      <motion.section 
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        style={{
          background: "linear-gradient(135deg, rgba(23, 24, 30, 0.9) 0%, rgba(15, 16, 22, 0.95) 100%)",
          border: "1px solid rgba(226, 227, 233, 0.05)",
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
        
        <motion.p 
          variants={fadeInVariants}
          style={{ color: "var(--color-stone-text)", fontSize: "14px", lineHeight: "1.6", margin: 0 }}
        >
          To manage your connected instances, track semantic context themes, and monitor contradictions, all you need is a secure **Client API Key**. This key authenticates your local desktop or web-based AI clients to securely interface with your memory core.
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
      </motion.section>

    </div>
  );
}
