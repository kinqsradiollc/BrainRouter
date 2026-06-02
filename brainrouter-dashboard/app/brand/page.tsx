"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { DEFAULT_CONFIG, dimsFor, type BrandConfig } from "./brandPresets";
import { buildSVG } from "./buildSVG";
import { useBrandExport } from "./useBrandExport";
import { BrandControls } from "./BrandControls";

export default function BrandStudioPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [cfg, setCfg] = useState<BrandConfig>(DEFAULT_CONFIG);

  // Admin-only: AuthGuard redirects unauthenticated users to /auth; authed
  // non-admins get bounced to /overview (mirrors the Users console).
  useEffect(() => {
    if (user && !user.isAdmin) router.replace("/overview");
  }, [user, router]);

  const set = (patch: Partial<BrandConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const svg = useMemo(() => buildSVG(cfg), [cfg]);
  const previewSvg = useMemo(() => svg.replace("<svg ", '<svg style="display:block;width:100%;height:auto" '), [svg]);
  const { downloadSVG, downloadPNG, copySVG, busy, copied } = useBrandExport(cfg);

  if (isLoading) {
    return <div style={{ padding: "48px", color: "var(--text-muted)" }}>Loading…</div>;
  }
  if (!user || !user.isAdmin) return null;

  const { w, h } = dimsFor(cfg);
  const ar = w / h;
  const previewMaxW = ar < 1 ? Math.round(660 * ar) : ar > 2.4 ? 860 : 700;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "1400px" }}>
      {/* header */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "26px", fontWeight: 600, letterSpacing: "-0.02em", margin: 0, color: "var(--text)" }}>Brand Studio</h1>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--accent)", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", borderRadius: "var(--radius-pill)", padding: "3px 10px" }}>
            Admin only
          </span>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px", margin: 0, maxWidth: "62ch", lineHeight: 1.55 }}>
          Generate on-brand social posters, banners, and release cards — version badges, the guilloché mark, and the Memory-Instrument palette, baked in. Everything is vector: export crisp <strong style={{ color: "var(--text)", fontWeight: 600 }}>SVG</strong> or hi-res <strong style={{ color: "var(--text)", fontWeight: 600 }}>PNG</strong>.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 340px) minmax(0, 1fr)", gap: "24px", alignItems: "start" }}>
        {/* controls */}
        <div
          style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-panel)",
            padding: "20px",
            position: "sticky",
            top: "16px",
            maxHeight: "calc(100vh - 110px)",
            overflowY: "auto",
          }}
        >
          <BrandControls cfg={cfg} set={set} />
        </div>

        {/* preview + export */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "28px",
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-panel)",
              minHeight: "340px",
            }}
          >
            <div
              style={{ width: "100%", maxWidth: `${previewMaxW}px`, borderRadius: "12px", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}
              dangerouslySetInnerHTML={{ __html: previewSvg }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={downloadPNG}
              disabled={busy}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "11px 20px",
                borderRadius: "10px",
                background: "var(--accent)",
                border: "1px solid var(--accent)",
                color: "#06130E",
                fontWeight: 600,
                fontSize: "14px",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.7 : 1,
              }}
            >
              {busy ? "Rendering…" : `Download PNG (${w}×${h})`}
            </button>
            <button
              type="button"
              onClick={downloadSVG}
              style={{
                padding: "11px 20px",
                borderRadius: "10px",
                background: "var(--surface-overlay)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
                fontWeight: 600,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              Download SVG
            </button>
            <button
              type="button"
              onClick={copySVG}
              style={{
                padding: "11px 20px",
                borderRadius: "10px",
                background: "transparent",
                border: "1px solid var(--border-strong)",
                color: copied ? "var(--accent)" : "var(--text-secondary)",
                fontWeight: 600,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied ✓" : "Copy SVG"}
            </button>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>
              SVG keeps text editable · PNG flattens to {w}×{h}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
