"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { STATIC_PRESENTATION } from "../../lib/presentation";
import { slideStagger, slideChild } from "../../components/home/landingData";

const GITHUB_URL = "https://github.com/kinqsradiollc/BrainRouter";

type Surface = {
  tag: string;
  title: string;
  body: string;
  /** npm package (always shown — external link, safe in presentation mode). */
  pkg?: { name: string; url: string };
  /** Internal app route — only rendered as a link outside presentation mode. */
  link?: { href: string; label: string };
  /** Not shipped yet — shows a "Coming soon" badge, no link/pkg. */
  comingSoon?: boolean;
};

const NPM = (name: string) => ({ name, url: `https://www.npmjs.com/package/${name}` });

const SURFACES: Surface[] = [
  {
    tag: "TERMINAL",
    title: "brainrouter CLI",
    body: "Memory-native coding agent: ~70 slash commands, an LLM-driven compactor, hookify guardrails, and durable per-session transcripts.",
    pkg: NPM("@kinqs/brainrouter-cli"),
  },
  {
    tag: "DESKTOP",
    title: "BrainRouter Desktop",
    body: "The memory-native coding agent as a native desktop app — the same memory graph, multi-agent runs, and workflows, in a full UI.",
    comingSoon: true,
  },
  {
    tag: "MULTI-AGENT",
    title: "Five bounded roles",
    body: "explorer · architect · reviewer · worker · verifier. Each opens memory-first; large child outputs offload to a working canvas instead of polluting context.",
  },
  {
    tag: "BROWSER",
    title: "Dashboard",
    body: "Inspect recall, scenes, contradictions, evidence, and the knowledge graph — and administer providers, integrations, and organizations — all over the same store.",
    link: { href: "/overview", label: "/overview" },
  },
  {
    tag: "PROTOCOL",
    title: "MCP + HTTP API",
    body: "Plug into any MCP host, or call the HTTP chat-completions route directly — every client inherits the same memory stack.",
    pkg: NPM("@kinqs/brainrouter-mcp-server"),
  },
  {
    tag: "MEMORY",
    title: "Source-grounded recall",
    body: "Turns are captured as source chunks, every memory cites the chunks it was distilled from, and recall drills from a compact hit down to the original source — with a staged blackboard, a summary tree, and a read-only vault behind it.",
    link: { href: "/sources", label: "source chunks" },
  },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)", fontWeight: 600 }}>
      {children}
    </span>
  );
}

export default function AboutPage() {
  return (
    <div style={{ maxWidth: "960px", margin: "8px auto 40px", display: "flex", flexDirection: "column", gap: "64px" }}>

      {/* Hero — animates on mount (above the fold) */}
      <motion.section
        variants={slideStagger}
        initial="hidden"
        animate="show"
        style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "center", textAlign: "center", paddingTop: "16px" }}
      >
        <motion.div variants={slideChild}><Eyebrow>Open source · Memory-first</Eyebrow></motion.div>
        <motion.h1 variants={slideChild} style={{ fontSize: "clamp(32px, 4.4vw, 48px)", lineHeight: 1.08, letterSpacing: "-0.03em", fontWeight: 600, margin: 0, maxWidth: "16ch", color: "var(--text)" }}>
          Why <span style={{ color: "var(--accent)" }}>BrainRouter</span> exists.
        </motion.h1>
        <motion.p variants={slideChild} style={{ color: "var(--text-secondary)", fontSize: "17px", lineHeight: 1.65, maxWidth: "62ch", margin: "4px 0 0" }}>
          AI agents forget. Every session starts from zero, so they re-learn the same facts and lose the thread of long projects. BrainRouter is a cognitive memory engine that models agent memory the way the mind works — short-term feeds long-term, unused facts fade, and the ones that get used are reinforced. Run it entirely on your own machine, or connect your agents to a hosted engine.
        </motion.p>
      </motion.section>

      {/* Principles */}
      <motion.section
        variants={slideStagger}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}
      >
        <motion.div variants={slideChild} style={{ background: "var(--surface-raised)", border: "1px solid var(--border-med)", borderRadius: "var(--radius-panel)", padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ width: "38px", height: "38px", borderRadius: "10px", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <h3 style={{ fontSize: "19px", fontWeight: 600, margin: 0, color: "var(--text)" }}>Your memory, your machine</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: 1.6, margin: 0 }}>
            Your prompts, facts, rules, and contradictions live in a database you control. Self-host the MCP server against your own storage and model endpoint — no data leaves your machine, no multi-tenant mixing.
          </p>
        </motion.div>

        <motion.div variants={slideChild} style={{ background: "var(--surface-raised)", border: "1px solid var(--border-med)", borderRadius: "var(--radius-panel)", padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ width: "38px", height: "38px", borderRadius: "10px", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </div>
          <h3 style={{ fontSize: "19px", fontWeight: 600, margin: 0, color: "var(--text)" }}>Open source, MIT</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: 1.6, margin: 0 }}>
            The engine, CLI, and dashboard are MIT-licensed and fully open. Run your own MCP server, write hookify guardrails, swap the database adapter, or read exactly how recall works.
          </p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--accent)", fontSize: "13px", fontWeight: 600, textDecoration: "none", marginTop: "2px", width: "fit-content" }}
          >
            <span>View source on GitHub</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="7" y1="17" x2="17" y2="7" />
              <polyline points="7 7 17 7 17 17" />
            </svg>
          </a>
        </motion.div>
      </motion.section>

      {/* What ships today */}
      <motion.section
        variants={slideStagger}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
        style={{ display: "flex", flexDirection: "column", gap: "20px" }}
      >
        <motion.div variants={slideChild} style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "640px" }}>
          <Eyebrow>What ships today</Eyebrow>
          <h2 style={{ fontSize: "clamp(24px, 3vw, 32px)", lineHeight: 1.12, letterSpacing: "-0.02em", fontWeight: 600, margin: 0, color: "var(--text)" }}>
            One memory engine. Every surface.
          </h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "15px", lineHeight: 1.6, margin: 0 }}>
            BrainRouter is a cognitive substrate you can drive from a terminal, a browser, or any MCP-compatible agent. Every surface shares the same memory store, recall pipeline, and contradiction loop.
          </p>
        </motion.div>

        <motion.div variants={slideChild} style={{ display: "flex", flexDirection: "column", gap: "8px", maxWidth: "640px", minWidth: 0 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Install from npm
          </span>
          <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border-med)", borderRadius: "var(--radius-card)", padding: "12px 16px", overflowX: "auto", minWidth: 0, maxWidth: "100%" }}>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--text)", whiteSpace: "nowrap" }}>
              <span style={{ color: "var(--text-muted)" }}>$ </span>npm install -g @kinqs/brainrouter-cli @kinqs/brainrouter-mcp-server
            </code>
          </div>
        </motion.div>

        <motion.div variants={slideStagger} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "16px" }}>
          {SURFACES.map((s) => (
            <motion.div key={s.tag} variants={slideChild} style={{ background: "var(--surface-raised)", border: "1px solid var(--border-med)", borderRadius: "var(--radius-panel)", padding: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", color: "var(--accent)", fontWeight: 600 }}>{s.tag}</span>
                {s.comingSoon && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", borderRadius: "var(--radius-pill)", padding: "2px 8px", whiteSpace: "nowrap" }}>
                    Coming soon
                  </span>
                )}
              </div>
              <h3 style={{ fontSize: "17px", fontWeight: 600, margin: 0, color: "var(--text)" }}>{s.title}</h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "13px", lineHeight: 1.55, margin: 0 }}>
                {s.body}
              </p>
              {(s.pkg || (!STATIC_PRESENTATION && s.link)) && (
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", marginTop: "auto", paddingTop: "10px", borderTop: "1px solid var(--border)" }}>
                  {s.pkg && (
                    <a
                      href={s.pkg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--text-muted)", fontSize: "12px", fontFamily: "var(--font-mono)", textDecoration: "none", transition: "color 0.18s ease" }}
                      onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
                      onMouseOut={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                    >
                      {s.pkg.name}
                    </a>
                  )}
                  {/* internal app routes redirect to / in presentation mode — only link outside it */}
                  {!STATIC_PRESENTATION && s.link && (
                    <Link href={s.link.href} style={{ color: "var(--accent)", fontSize: "12px", fontFamily: "var(--font-mono)", textDecoration: "none" }}>
                      → {s.link.label}
                    </Link>
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </motion.div>
      </motion.section>

      {/* Self-host or connect */}
      <motion.section
        variants={slideStagger}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
        style={{ background: "var(--surface-overlay)", border: "1px solid var(--border-med)", borderRadius: "16px", padding: "clamp(28px, 4vw, 44px)", display: "flex", flexDirection: "column", gap: "18px" }}
      >
        <motion.h2 variants={slideChild} style={{ fontSize: "clamp(22px, 2.6vw, 28px)", lineHeight: 1.15, letterSpacing: "-0.02em", fontWeight: 600, margin: 0, color: "var(--text)" }}>
          Self-host it, or connect to the hosted engine.
        </motion.h2>

        <motion.p variants={slideChild} style={{ color: "var(--text-secondary)", fontSize: "15px", lineHeight: 1.65, margin: 0 }}>
          BrainRouter runs as your own local MCP server, bound to your filesystem and workspace — or your agents can connect to a hosted memory engine over the HTTP API. Either way the memory model, recall pipeline, and contradiction loop are identical.
        </motion.p>

        {!STATIC_PRESENTATION ? (
          <>
            <motion.p variants={slideChild} style={{ color: "var(--text-secondary)", fontSize: "15px", lineHeight: 1.65, margin: 0 }}>
              To connect a client to the hosted engine — to manage your instances, track context themes, and monitor contradictions — all you need is a secure <strong style={{ color: "var(--text)", fontWeight: 600 }}>Client API Key</strong> that authenticates your local or web AI clients to your memory core.
            </motion.p>
            <motion.div variants={slideChild} style={{ paddingTop: "4px" }}>
              <Link href="/auth">
                <motion.button
                  className="button-gold"
                  style={{ padding: "12px 24px", borderRadius: "var(--radius-pill)", fontWeight: 600, fontSize: "14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px" }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <span>Get your Client API Key</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </motion.button>
              </Link>
            </motion.div>
          </>
        ) : (
          <motion.div variants={slideChild} style={{ paddingTop: "4px" }}>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
              <motion.button
                className="button-gold"
                style={{ padding: "12px 24px", borderRadius: "var(--radius-pill)", fontWeight: 600, fontSize: "14px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px" }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <span>Clone &amp; self-host</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </motion.button>
            </a>
          </motion.div>
        )}
      </motion.section>

      {/* Core Maintainer / Contact */}
      <motion.section
        variants={slideStagger}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-80px" }}
        style={{ display: "flex", flexDirection: "column", gap: "20px" }}
      >
        <motion.div variants={slideChild} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <Eyebrow>Who builds this</Eyebrow>
          <h2 style={{ fontSize: "clamp(24px, 3vw, 32px)", lineHeight: 1.12, letterSpacing: "-0.02em", fontWeight: 600, margin: 0, color: "var(--text)" }}>
            Core maintainer
          </h2>
        </motion.div>

        <motion.div
          variants={slideChild}
          style={{ background: "var(--surface-raised)", border: "1px solid var(--border-med)", borderRadius: "var(--radius-panel)", padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div
              aria-hidden
              style={{ width: "52px", height: "52px", borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", color: "var(--accent)", fontWeight: 700, fontSize: "18px", letterSpacing: "0.02em" }}
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
              { kind: "linkedin", label: "linkedin.com/in/tran-duc-anh-dang", href: "https://www.linkedin.com/in/tran-duc-anh-dang-392b7a231/" },
            ].map((c) => (
              <a
                key={c.href}
                href={c.href}
                {...(c.kind === "linkedin" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                style={{ display: "inline-flex", alignItems: "center", gap: "10px", color: "var(--text-secondary)", fontSize: "14px", textDecoration: "none", transition: "color 0.2s ease", width: "fit-content" }}
                onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
                onMouseOut={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
              >
                <span
                  aria-hidden
                  style={{ width: "30px", height: "30px", flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-overlay)", border: "1px solid var(--border-med)", color: "var(--accent)" }}
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
