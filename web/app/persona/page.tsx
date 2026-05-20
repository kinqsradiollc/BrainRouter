"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { usePersona } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.12
    }
  }
};

export default function PersonaPage() {
  const client = useMemo(() => getClient(), []);
  const { persona } = usePersona(client);

  return (
    <AuthGuard>
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        {/* Editorial Title Block */}
        <PageHeader 
          title="Core Identity" 
          description="Distilled cognitive agent profile consolidating recurring scenes into a unified persistent identity." 
        />

        <motion.div 
          className="grid-asymmetric"
          variants={containerVariants}
          initial="hidden"
          animate="show"
        >
          {/* Left Side: Distilled Persona Profile Sheet */}
          <PremiumCard 
            level={1}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              minHeight: "400px"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(226, 227, 233, 0.04)", paddingBottom: "16px" }}>
              <h3 className="serif-display" style={{ fontSize: "22px", fontWeight: 500, margin: 0 }}>
                Consolidated Core Identity
              </h3>
              <span style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-golden-accent)", fontWeight: 600 }}>
                Persistent Profile
              </span>
            </div>

            <div style={{ position: "relative" }}>
              {persona ? (
                <p 
                  style={{ 
                    whiteSpace: "pre-wrap", 
                    color: "var(--color-white-frost)", 
                    fontSize: "15px", 
                    lineHeight: 1.7,
                    letterSpacing: "0.01em",
                    margin: 0,
                    fontFamily: "var(--font-inter)"
                  }}
                >
                  {persona.personaMd}
                </p>
              ) : (
                <div style={{ color: "var(--color-stone-text)", fontStyle: "italic", padding: "40px 0", textAlign: "center" }}>
                  No active core identity profile consolidated yet. Perform more turns to trigger identity distillation.
                </div>
              )}
            </div>
          </PremiumCard>

          {/* Right Side: Distillation Subsystem Stencil */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {/* Funnel Pipeline Visualizer */}
            <PremiumCard 
              level={2}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "16px"
              }}
            >
              <h4 className="serif-display" style={{ fontSize: "16px", fontWeight: 500, margin: 0, color: "var(--color-pure-white)" }}>
                Cognitive Distillation Funnel
              </h4>

              {/* Inline SVG Flow chart */}
              <div style={{ display: "flex", flexDirection: "column", gap: "24px", padding: "12px 4px", position: "relative" }}>
                
                {/* Funnel Stage 1 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", width: "28px", height: "28px", borderRadius: "50%", background: "rgba(226, 227, 233, 0.04)", border: "1px solid rgba(226, 227, 233, 0.1)", fontSize: "10px", color: "var(--color-stone-text)", fontWeight: 600, justifyContent: "center" }}>
                    CR
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-pure-white)" }}>Cognitive Records</div>
                    <div style={{ fontSize: "11px", color: "var(--color-ash-text)" }}>Structured episodic facts</div>
                  </div>
                </div>

                {/* Arrow SVG indicator */}
                <div style={{ paddingLeft: "12px", height: "16px", display: "flex", alignItems: "center" }}>
                  <svg width="8" height="16" viewBox="0 0 8 16" fill="none" stroke="rgba(204, 145, 102, 0.3)" strokeWidth="1.5">
                    <path d="M4 0v16M1 13l3 3 3-3" />
                  </svg>
                </div>

                {/* Funnel Stage 2 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", width: "28px", height: "28px", borderRadius: "50%", background: "rgba(204, 145, 102, 0.08)", border: "1px solid rgba(204, 145, 102, 0.2)", fontSize: "10px", color: "var(--color-golden-accent)", fontWeight: 600, justifyContent: "center" }}>
                    CF
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-pure-white)" }}>Focus Scenes</div>
                    <div style={{ fontSize: "11px", color: "var(--color-ash-text)" }}>Active contextual clusters</div>
                  </div>
                </div>

                {/* Arrow SVG indicator */}
                <div style={{ paddingLeft: "12px", height: "16px", display: "flex", alignItems: "center" }}>
                  <svg width="8" height="16" viewBox="0 0 8 16" fill="none" stroke="rgba(204, 145, 102, 0.3)" strokeWidth="1.5">
                    <path d="M4 0v16M1 13l3 3 3-3" />
                  </svg>
                </div>

                {/* Funnel Stage 3 */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", width: "28px", height: "28px", borderRadius: "50%", background: "var(--color-golden-accent)", fontSize: "10px", color: "var(--color-midnight-ink)", fontWeight: 700, boxShadow: "0 0 10px rgba(204, 145, 102, 0.4)", justifyContent: "center" }}>
                    CI
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-pure-white)" }}>Core Identity</div>
                    <div style={{ fontSize: "11px", color: "var(--color-ash-text)" }}>Distilled persona profile</div>
                  </div>
                </div>

              </div>
            </PremiumCard>
          </div>
        </motion.div>
      </motion.div>
    </AuthGuard>
  );
}
