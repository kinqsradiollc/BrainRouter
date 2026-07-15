"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/AuthProvider";
import { useIsMobile } from "../../lib/useIsMobile";
import { allowsRasterExport, DEFAULT_CONFIG, dimsFor, type BrandConfig, type Mode } from "./brandPresets";
import { buildSVG } from "./buildSVG";
import { useBrandExport } from "./useBrandExport";
import { BrandControls } from "./BrandControls";
import { Editor } from "./editor/Editor";

const MODES: [Mode, string][] = [
  ["canvas", "Poster studio"],
  ["avatar", "Avatar / PFP"],
  ["logo", "Logo"],
];

export default function BrandStudioPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [cfg, setCfg] = useState<BrandConfig>(DEFAULT_CONFIG);
  const [scale, setScale] = useState(2);
  const isMobile = useIsMobile();

  // Admin-only: AuthGuard redirects unauthenticated users to /auth; authed
  // non-admins get bounced to /overview (mirrors the Users console).
  useEffect(() => {
    if (user && !user.isAdmin) router.replace("/overview");
  }, [user, router]);

  const set = (patch: Partial<BrandConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const svg = useMemo(() => buildSVG(cfg), [cfg]);
  const { downloadSVG, downloadPNG, copySVG, busy, copied } = useBrandExport(cfg);

  if (isLoading) {
    return <div style={{ padding: "48px", color: "var(--text-muted)" }}>Loading…</div>;
  }
  if (!user || !user.isAdmin) return null;

  const { w, h } = dimsFor(cfg);
  const ar = w / h;
  const previewMaxW = ar < 1 ? Math.round(660 * ar) : ar > 2.4 ? 860 : 700;
  const previewHtml = svg.replace(
    "<svg ",
    `<svg style="display:block;width:auto;height:auto;max-width:min(100%, ${previewMaxW}px);max-height:70vh;margin:0 auto;border-radius:12px" `
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "1400px" }}>
      {/* header */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "24px", lineHeight: "32px", fontWeight: 600, letterSpacing: "-0.02em", margin: 0, color: "var(--text)" }}>Brand Studio</h1>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--accent)", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", borderRadius: "var(--radius-pill)", padding: "3px 10px" }}>
            Admin only
          </span>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: "14px", margin: 0, maxWidth: "62ch", lineHeight: 1.55 }}>
          Start from a release, feature, role, quote, or lockup template, then edit its layers and safe zones. Every brand layer uses the coded Routed B and the shared neutral palette. Logo mode exports editable <strong style={{ color: "var(--text)", fontWeight: 600 }}>SVG</strong>; poster and avatar compositions can also export a flattened <strong style={{ color: "var(--text)", fontWeight: 600 }}>PNG</strong>.
        </p>
      </div>

      {/* mode switcher */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {MODES.map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => set({ mode: m })}
            style={{
              height: "var(--control-size)",
              padding: "0 12px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
              background: cfg.mode === m ? "var(--accent-wash)" : "var(--surface-raised)",
              border: `1px solid ${cfg.mode === m ? "var(--border-hover-accent)" : "var(--border)"}`,
              color: cfg.mode === m ? "var(--accent)" : "var(--text-secondary)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {cfg.mode === "canvas" ? (
        <Editor />
      ) : (
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(300px, 340px) minmax(0, 1fr)", gap: "24px", alignItems: "start" }}>
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
              style={{ width: "100%", display: "flex", justifyContent: "center" }}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {allowsRasterExport(cfg.mode) ? (
              <>
                <select
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                  title="PNG resolution"
                  style={{ height: "var(--control-size)", padding: "0 10px", borderRadius: "8px", background: "var(--surface-overlay)", border: "1px solid var(--border-strong)", color: "var(--text)", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
                >
                  <option value={1}>1×</option>
                  <option value={2}>2× HD</option>
                  <option value={3}>3×</option>
                  <option value={4}>4×</option>
                </select>
                <button
                  type="button"
                  onClick={() => downloadPNG(scale)}
                  disabled={busy}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    height: "var(--control-size)",
                    padding: "0 12px",
                    borderRadius: "8px",
                    background: "var(--accent)",
                    border: "1px solid var(--accent)",
                    color: "var(--surface-base)",
                    fontWeight: 600,
                    fontSize: "13px",
                    cursor: busy ? "default" : "pointer",
                    opacity: busy ? 0.7 : 1,
                  }}
                >
                  {busy ? "Rendering…" : `Download PNG (${Math.round(w * scale)}×${Math.round(h * scale)})`}
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={downloadSVG}
              style={{
                height: "var(--control-size)",
                padding: "0 12px",
                borderRadius: "8px",
                background: "var(--surface-overlay)",
                border: "1px solid var(--border-strong)",
                color: "var(--text)",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              Download SVG
            </button>
            <button
              type="button"
              onClick={copySVG}
              style={{
                height: "var(--control-size)",
                padding: "0 12px",
                borderRadius: "8px",
                background: "transparent",
                border: "1px solid var(--border-strong)",
                color: copied ? "var(--accent)" : "var(--text-secondary)",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy SVG"}
            </button>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>
              {cfg.mode === "logo" ? "SVG stays code-rendered and editable" : `SVG stays editable · PNG flattens to ${w}×${h}`}
            </span>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
