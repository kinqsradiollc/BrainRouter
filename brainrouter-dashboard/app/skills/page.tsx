"use client";

import { useMemo } from "react";
import { useSkillActivations } from "@kinqs/brainrouter-hooks";
import { getClient } from "../../lib/client";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";

export default function SkillsPage() {
  const client = useMemo(() => getClient(), []);
  const { data, error, loading, refresh } = useSkillActivations(client);
  // The endpoint returns an array; guard so a thinner-than-typed response
  // (e.g. an error object) degrades to the empty state instead of throwing
  // `activations.map is not a function`.
  const activations = Array.isArray(data) ? data : [];

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
          <div style={{ padding: "16px", background: "rgba(229, 103, 95, 0.1)", border: "1px solid #E5675F", borderRadius: "8px", color: "#E5675F" }}>
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: "20px" }}>
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
                      border: isPrewarmed ? "1px solid rgba(52, 194, 142, 0.3)" : "1px solid var(--border-dim)",
                      borderRadius: "12px",
                      padding: "20px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "12px",
                      boxShadow: isPrewarmed ? "var(--elev-inset)" : "none",
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
                          background: isPrewarmed ? "rgba(52, 194, 142, 0.15)" : "rgba(255, 255, 255, 0.05)",
                          color: isPrewarmed ? "var(--color-golden-accent)" : "var(--color-ash-text)",
                          border: isPrewarmed ? "1px solid rgba(52, 194, 142, 0.3)" : "1px solid transparent",
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
                              ? "linear-gradient(90deg, #34C28E 0%, #34C28E 100%)" 
                              : "linear-gradient(90deg, #3C434B 0%, #6B7480 100%)",
                            borderRadius: "9999px",
                            boxShadow: isPrewarmed ? "none" : "none",
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
