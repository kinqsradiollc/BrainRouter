"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthProvider";
import { BASE_URL } from "../lib/client";
import { getApiKey } from "../lib/client-auth";
import { PremiumButton } from "./PremiumButton";

export function McpOnboardingBanner() {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(localStorage.getItem("brainrouter_mcp_onboarded") !== "true");
  }, []);

  const config = useMemo(() => JSON.stringify({
    mcpServers: {
      brainrouter: {
        type: "sse",
        url: `${BASE_URL}/mcp`,
        headers: { Authorization: `Bearer ${getApiKey() || "<apiKey>"}` },
      },
    },
  }, null, 2), []);

  if (!visible || !user) return null;

  return (
    <section className="card-premium" style={{ padding: "18px", border: "1px solid rgba(204,145,102,0.35)", display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0, color: "var(--color-pure-white)", fontSize: "18px" }}>Connect your MCP client</h2>
          <p style={{ margin: "6px 0 0", color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.5 }}>
            Use this config to connect a desktop MCP client to the active BrainRouter daemon.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem("brainrouter_mcp_onboarded", "true");
            setVisible(false);
          }}
          style={{ background: "transparent", border: "none", color: "var(--color-silver-text)", cursor: "pointer", fontSize: "18px" }}
          aria-label="Dismiss MCP onboarding"
        >
          ×
        </button>
      </div>
      <pre style={{ margin: 0, padding: "12px", borderRadius: "8px", background: "#000", color: "var(--color-silver-text)", overflowX: "auto", fontSize: "12px" }}>{config}</pre>
      <div>
        <PremiumButton variant="primary" onClick={() => navigator.clipboard.writeText(config)}>
          Copy Config
        </PremiumButton>
      </div>
    </section>
  );
}
