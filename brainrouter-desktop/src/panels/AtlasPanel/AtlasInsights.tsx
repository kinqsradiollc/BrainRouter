/**
 * Atlas Deep Dive overlay — whole-graph project stats (counts, file types,
 * languages, complexity, frameworks, most-connected). Pure presentation over
 * {@link atlasProjectStats}; extracted from AtlasPanel so the panel stays thin.
 */
import React from "react";
import type { AtlasFileCategory } from "@kinqs/brainrouter-types";
import { atlasProjectStats, ATLAS_CATEGORY_COLORS } from "../../lib/atlas/atlasView.js";
import { Icon } from "../../icons.js";

export interface AtlasInsightsProps {
  stats: NonNullable<ReturnType<typeof atlasProjectStats>>;
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function AtlasInsights({ stats, onClose, onSelect }: AtlasInsightsProps): React.ReactElement {
  return (
    <div className="atlas-insights">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>Deep Dive</strong>
        <button className="atlas-detail-x" onClick={onClose} aria-label="Close insights" title="Close"><Icon name="close" size={11} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
        {([["Nodes", stats.nodes], ["Edges", stats.edges], ["Layers", stats.layers], ["Files", stats.files]] as Array<[string, number]>).map(([k, v]) => (
          <div key={k} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 9px" }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{v}</div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>{k}</div>
          </div>
        ))}
      </div>
      {([
        { title: "File types", items: stats.byCategory.map((c) => ({ key: c.key, count: c.count, color: ATLAS_CATEGORY_COLORS[c.key as AtlasFileCategory] })) },
        { title: "Languages", items: stats.languages.map((l) => ({ key: l.key, count: l.count, color: "var(--accent)" })) },
        { title: "Complexity", items: stats.byComplexity.map((c) => ({ key: c.key, count: c.count, color: "var(--text-dim)" })) },
      ] as Array<{ title: string; items: Array<{ key: string; count: number; color?: string }> }>).filter((s) => s.items.length).map((sec) => {
        const max = Math.max(1, ...sec.items.map((i) => i.count));
        return (
          <div key={sec.title} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{sec.title}</div>
            {sec.items.map((it) => (
              <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color ?? "var(--accent)", flex: "0 0 auto" }} />
                <span style={{ fontSize: 11, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.key}</span>
                <span style={{ position: "relative", width: 56, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)" }}>
                  <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(it.count / max) * 100}%`, borderRadius: 2, background: it.color ?? "var(--accent)", opacity: 0.7 }} />
                </span>
                <span style={{ fontSize: 10, color: "var(--text-dim)", width: 26, textAlign: "right" }}>{it.count}</span>
              </div>
            ))}
          </div>
        );
      })}
      {stats.frameworks.length ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Frameworks</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {stats.frameworks.map((f) => <span key={f} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)" }}>{f}</span>)}
          </div>
        </div>
      ) : null}
      {stats.topConnected.length ? (
        <div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Most connected</div>
          {stats.topConnected.map((t) => (
            <button key={t.id} onClick={() => onSelect(t.id)} style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 6, background: "none", border: "none", color: "inherit", padding: "3px 0", cursor: "pointer", textAlign: "left" }} title={t.name}>
              <span style={{ fontSize: 11, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t.degree} links</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
