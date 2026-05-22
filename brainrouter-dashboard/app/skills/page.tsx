"use client";

import { useMemo } from "react";
import { useSkillActivations } from "@brainrouter/hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";

export default function SkillsPage() {
  const client = useMemo(() => getClient(), []);
  const { data: activations, error, loading, refresh } = useSkillActivations(client);

  return (
    <AuthGuard>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <PageHeader 
          title="Skill Routing" 
          description="View dynamic activation potentials and pre-warming thresholds modeled after spiking neural network leakage." 
        />

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button 
            id="btn-refresh-skills"
            onClick={() => refresh()} 
            disabled={loading} 
            style={{ 
              marginLeft: "auto", 
              padding: "6px 16px", 
              borderRadius: "9999px", 
              border: "1px solid var(--border-med)", 
              background: "transparent", 
              color: "var(--color-silver-text)",
              cursor: "pointer",
              fontSize: "13px",
              transition: "all 0.2s ease"
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = "var(--color-golden-accent)";
              e.currentTarget.style.color = "var(--color-pure-white)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = "var(--border-med)";
              e.currentTarget.style.color = "var(--color-silver-text)";
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {error && (
          <div style={{ padding: "16px", background: "rgba(239, 68, 68, 0.1)", border: "1px solid #ef4444", borderRadius: "8px", color: "#f87171" }}>
            Failed to load skill activations: {error}
          </div>
        )}

        <div className="table-container" style={{ padding: "20px" }}>
          {!activations || activations.length === 0 ? (
            <EmptyState 
              title="No Skill Activations" 
              description="Activate skill-specific tools (e.g. by using an active skill inside recall or capture) to see activation potential build up." 
            />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "20px" }}>
              {activations.map((act) => {
                const maxPotential = 4.0;
                const percentage = Math.min(100, (act.potential / maxPotential) * 100);
                const isPrewarmed = act.potential >= 0.3;
                const lastUsed = new Date(act.lastDecayTime);

                return (
                  <div 
                    key={act.skillName}
                    style={{
                      background: "rgba(255, 255, 255, 0.02)",
                      border: isPrewarmed ? "1px solid rgba(174, 147, 87, 0.3)" : "1px solid var(--border-dim)",
                      borderRadius: "12px",
                      padding: "20px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "12px",
                      boxShadow: isPrewarmed ? "0 4px 20px rgba(174, 147, 87, 0.05)" : "none",
                      transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.background = "rgba(255, 255, 255, 0.04)";
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.transform = "translateY(0)";
                      e.currentTarget.style.background = "rgba(255, 255, 255, 0.02)";
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-pure-white)", letterSpacing: "-0.01em" }}>
                        {act.skillName}
                      </span>
                      <span 
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "2px 8px",
                          borderRadius: "9999px",
                          background: isPrewarmed ? "rgba(174, 147, 87, 0.15)" : "rgba(255, 255, 255, 0.05)",
                          color: isPrewarmed ? "var(--color-golden-accent)" : "var(--color-ash-text)",
                          border: isPrewarmed ? "1px solid rgba(174, 147, 87, 0.3)" : "1px solid transparent",
                        }}
                      >
                        {isPrewarmed ? "PRE-WARMED" : "INACTIVE"}
                      </span>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--color-ash-text)" }}>
                        <span>Potential (charge)</span>
                        <span style={{ color: "var(--color-silver-text)", fontWeight: 500 }}>
                          {act.potential.toFixed(2)} / {maxPotential.toFixed(1)}
                        </span>
                      </div>
                      <div style={{ width: "100%", height: "6px", background: "rgba(255, 255, 255, 0.05)", borderRadius: "9999px", overflow: "hidden" }}>
                        <div 
                          style={{ 
                            width: `${percentage}%`, 
                            height: "100%", 
                            background: isPrewarmed 
                              ? "linear-gradient(90deg, #ae9357 0%, #ecd08c 100%)" 
                              : "linear-gradient(90deg, #4b5563 0%, #9ca3af 100%)",
                            borderRadius: "9999px",
                            boxShadow: isPrewarmed ? "0 0 8px rgba(174, 147, 87, 0.5)" : "none",
                            transition: "width 0.5s ease-out"
                          }} 
                        />
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", borderTop: "1px solid var(--border-dim)", paddingTop: "10px", marginTop: "4px" }}>
                      <span style={{ fontSize: "10px", color: "var(--color-ash-text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Last Activity Spike
                      </span>
                      <span style={{ fontSize: "12px", color: "var(--color-silver-text)", fontFamily: "monospace" }}>
                        {lastUsed.toLocaleString()}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  );
}
