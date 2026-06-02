/**
 * EcosystemSection (0.4.9 DASH-ECOSYSTEM) — features the whole BrainRouter
 * product surface on the landing: one memory engine, three surfaces (MCP server,
 * CLI agent, dashboard), and the headline capabilities. Design-language compliant
 * (Signal accent, mono labels, color-stepped cards, hairline borders, no glow).
 *
 * Presentational only (no hooks) — renders inside the client landing page.
 */

const SURFACES = [
  {
    tag: "MCP SERVER",
    pkg: "@kinqs/brainrouter-mcp-server",
    title: "The memory engine, as MCP tools",
    body: "Durable recall, capture, focus scenes, persona, contradictions, and code-aware retrieval — exposed to any MCP-speaking agent (Claude, Codex, Cursor, Gemini).",
    mark: "M",
  },
  {
    tag: "CLI AGENT",
    pkg: "@kinqs/brainrouter-cli",
    title: "A memory-first terminal agent",
    body: "Briefing from your own memory every turn, multi-agent orchestration, deterministic multi-phase workflows, sandboxed execution, and cross-CLI federation.",
    mark: "C",
  },
  {
    tag: "DASHBOARD",
    pkg: "brainrouter-dashboard",
    title: "See the cognitive graph",
    body: "Visualize the memory graph, recall histories, focus scenes, provenance, and live sessions — the instrument you're looking at right now.",
    mark: "D",
  },
];

const CAPABILITIES = [
  "Memory engine",
  "Deterministic workflows",
  "Multi-agent orchestration",
  "Cross-CLI federation",
  "Code-aware recall",
  "Provenance + staleness",
  "Personas",
  "Focus scenes",
];

export function EcosystemSection() {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "32px",
        padding: "64px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "720px" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--accent)",
            fontWeight: 500,
          }}
        >
          The BrainRouter Ecosystem
        </span>
        <h2 style={{ fontSize: "30px", lineHeight: 1.1, fontWeight: 600, letterSpacing: "-0.02em", margin: 0, color: "var(--text)" }}>
          One memory. Every surface.
        </h2>
        <p style={{ fontSize: "16px", lineHeight: 1.55, color: "var(--text-secondary)", margin: 0 }}>
          A single cognitive substrate, three ways to use it. The same durable memory
          flows across your MCP-connected agents, the terminal CLI, and this dashboard.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "16px",
        }}
      >
        {SURFACES.map((s) => (
          <div
            key={s.tag}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              padding: "24px",
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--elev-inset)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div
                aria-hidden
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--accent-wash)",
                  color: "var(--accent)",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  fontSize: "15px",
                }}
              >
                {s.mark}
              </div>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                }}
              >
                {s.tag}
              </span>
            </div>
            <h3 style={{ fontSize: "17px", fontWeight: 600, letterSpacing: "-0.01em", margin: 0, color: "var(--text)" }}>
              {s.title}
            </h3>
            <p style={{ fontSize: "14px", lineHeight: 1.55, color: "var(--text-secondary)", margin: 0, flex: 1 }}>
              {s.body}
            </p>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                color: "var(--text-muted)",
                paddingTop: "4px",
                borderTop: "1px solid var(--border)",
              }}
            >
              {s.pkg}
            </code>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {CAPABILITIES.map((c) => (
          <span
            key={c}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              color: "var(--text-secondary)",
              padding: "6px 12px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-chip)",
              background: "var(--surface-raised)",
            }}
          >
            {c}
          </span>
        ))}
      </div>
    </section>
  );
}
