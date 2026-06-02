"use client";

import type { CSSProperties } from "react";
import { motion } from "framer-motion";

/**
 * HeroGraph — the marketing hero's product motif: an abstract memory graph.
 * Nodes are heat-filled (Recall-Heat ramp = freshness), edges encode association
 * strength, and one Signal node "breathes" as the live recall focus. On-brand per
 * the design language ("the product is the picture"); transform/opacity motion only
 * (respects the app-level reduced-motion config). Purely presentational.
 */

interface Node {
  id: string;
  x: number;
  y: number;
  r: number;
  fill: string;
  label?: string;
  live?: boolean;
}

// Heat ramp tokens (kept literal here so the motif is self-contained).
const HOT = "#E0A063";
const WARM = "#C98F6E";
const COOL = "#6B7480";
const COLD = "#3C434B";
const SIGNAL = "#34C28E";

const NODES: Node[] = [
  { id: "core", x: 232, y: 168, r: 26, fill: SIGNAL, label: "recall", live: true },
  { id: "a", x: 120, y: 92, r: 18, fill: HOT, label: "scene" },
  { id: "b", x: 350, y: 96, r: 15, fill: WARM },
  { id: "c", x: 96, y: 250, r: 14, fill: COOL },
  { id: "d", x: 360, y: 250, r: 19, fill: HOT, label: "fact" },
  { id: "e", x: 224, y: 300, r: 13, fill: COLD },
  { id: "f", x: 300, y: 178, r: 11, fill: COOL },
  { id: "g", x: 158, y: 188, r: 12, fill: WARM },
];

const byId = (id: string) => NODES.find((n) => n.id === id)!;

// [from, to, strength 0..1]
const EDGES: [string, string, number][] = [
  ["core", "a", 0.9],
  ["core", "b", 0.5],
  ["core", "d", 0.85],
  ["core", "g", 0.7],
  ["core", "f", 0.6],
  ["a", "g", 0.4],
  ["d", "e", 0.35],
  ["c", "g", 0.45],
  ["b", "f", 0.3],
  ["e", "c", 0.25],
];

export function HeroGraph() {
  return (
    <div
      aria-hidden
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 480,
        aspectRatio: "1.3 / 1",
        borderRadius: "var(--radius-panel)",
        border: "1px solid var(--border)",
        background:
          "var(--aura-signal), var(--surface-raised)",
        boxShadow: "var(--shadow-lg), var(--elev-inset)",
        overflow: "hidden",
      }}
    >
      {/* faint grid texture */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(var(--border-dim) 1px, transparent 1px), linear-gradient(90deg, var(--border-dim) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(110% 90% at 60% 40%, #000 35%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(110% 90% at 60% 40%, #000 35%, transparent 78%)",
          opacity: 0.5,
        }}
      />

      <svg viewBox="0 0 460 340" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        {/* edges */}
        {EDGES.map(([from, to, strength], i) => {
          const a = byId(from);
          const b = byId(to);
          return (
            <motion.line
              key={`${from}-${to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={from === "core" || to === "core" ? SIGNAL : "#FFFFFF"}
              strokeOpacity={from === "core" || to === "core" ? 0.18 + strength * 0.2 : 0.06 + strength * 0.06}
              strokeWidth={0.75 + strength * 1.25}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.9, delay: 0.1 + i * 0.05, ease: [0.2, 0.8, 0.2, 1] }}
            />
          );
        })}

        {/* nodes */}
        {NODES.map((n, i) => (
          <motion.g
            key={n.id}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.15 + i * 0.06, type: "spring", stiffness: 120, damping: 16 }}
            style={{ transformOrigin: `${n.x}px ${n.y}px` }}
          >
            {n.live && (
              <motion.circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill={SIGNAL}
                animate={{ r: [n.r, n.r + 12, n.r], opacity: [0.32, 0, 0.32] }}
                transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.fill} fillOpacity={n.live ? 0.95 : 0.85} />
            <circle cx={n.x} cy={n.y} r={n.r} fill="none" stroke="#FFFFFF" strokeOpacity={0.14} strokeWidth={1} />
            {/* inner top highlight */}
            <circle cx={n.x} cy={n.y - n.r * 0.32} r={n.r * 0.5} fill="#FFFFFF" fillOpacity={0.08} />
          </motion.g>
        ))}
      </svg>

      {/* a couple of provenance-style mono chips, the "system readout" layer */}
      <div style={{ position: "absolute", left: 16, bottom: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={chipStyle}>recall · 0.94</span>
        <span style={chipStyle}>fact · src:agent.ts</span>
      </div>
      <div style={{ position: "absolute", right: 16, top: 14, display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 7, height: 7, borderRadius: 9999, background: SIGNAL, display: "inline-block" }} />
        <span style={{ ...chipStyle, border: "none", background: "transparent", padding: 0 }}>live</span>
      </div>
    </div>
  );
}

const chipStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "-0.01em",
  color: "var(--text-muted)",
  background: "var(--surface-overlay)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-chip)",
  padding: "2px 8px",
};
