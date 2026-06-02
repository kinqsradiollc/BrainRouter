"use client";

import type { CSSProperties } from "react";
import {
  SIZES,
  THEMES,
  BACKGROUNDS,
  TEMPLATES,
  type BrandConfig,
  type PresetKey,
  type ThemeKey,
  type BgKey,
  type TemplateKey,
} from "./brandPresets";

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 600,
};

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  cols = 2,
}: {
  options: { v: T; label: string; note?: string }[];
  value: T;
  onChange: (v: T) => void;
  cols?: number;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "6px" }}>
      {options.map((o) => {
        const active = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "1px",
              padding: "8px 10px",
              borderRadius: "var(--radius-control)",
              cursor: "pointer",
              textAlign: "left",
              background: active ? "var(--accent-wash)" : "var(--surface-overlay)",
              border: `1px solid ${active ? "var(--border-hover-accent)" : "var(--border)"}`,
              color: active ? "var(--accent)" : "var(--text-secondary)",
              fontSize: "13px",
              fontWeight: active ? 600 : 500,
              transition: "all 0.15s ease",
            }}
          >
            <span>{o.label}</span>
            {o.note && <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-muted)" }}>{o.note}</span>}
          </button>
        );
      })}
    </div>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "9px 12px",
        borderRadius: "var(--radius-control)",
        background: "var(--surface-overlay)",
        border: "1px solid var(--border)",
        color: "var(--text)",
        fontSize: "13px",
        fontFamily: "var(--font-sans)",
        outline: "none",
      }}
    />
  );
}

function TextArea({ value, onChange, rows = 2 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "9px 12px",
        borderRadius: "var(--radius-control)",
        background: "var(--surface-overlay)",
        border: "1px solid var(--border)",
        color: "var(--text)",
        fontSize: "13px",
        lineHeight: 1.5,
        fontFamily: "var(--font-sans)",
        outline: "none",
        resize: "vertical",
      }}
    />
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "8px 12px",
        borderRadius: "var(--radius-control)",
        background: "var(--surface-overlay)",
        border: "1px solid var(--border)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontSize: "13px",
      }}
    >
      <span>{label}</span>
      <span
        style={{
          width: "34px",
          height: "20px",
          borderRadius: "9999px",
          background: checked ? "var(--accent)" : "var(--border-strong)",
          position: "relative",
          transition: "background 0.15s ease",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "16px" : "2px",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.15s ease",
          }}
        />
      </span>
    </button>
  );
}

export function BrandControls({ cfg, set }: { cfg: BrandConfig; set: (patch: Partial<BrandConfig>) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <Group label="Format">
        <Segmented<PresetKey>
          cols={1}
          value={cfg.preset}
          onChange={(v) => set({ preset: v })}
          options={(Object.keys(SIZES) as PresetKey[]).map((k) => ({ v: k, label: SIZES[k].label, note: SIZES[k].note }))}
        />
      </Group>

      <Group label="Template">
        <Segmented<TemplateKey>
          value={cfg.template}
          onChange={(v) => set({ template: v })}
          options={(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => ({ v: k, label: TEMPLATES[k] }))}
        />
      </Group>

      <Group label="Theme">
        <Segmented<ThemeKey>
          cols={3}
          value={cfg.theme}
          onChange={(v) => set({ theme: v })}
          options={(Object.keys(THEMES) as ThemeKey[]).map((k) => ({ v: k, label: THEMES[k].label }))}
        />
      </Group>

      <Group label="Background">
        <Segmented<BgKey>
          cols={3}
          value={cfg.background}
          onChange={(v) => set({ background: v })}
          options={(Object.keys(BACKGROUNDS) as BgKey[]).map((k) => ({ v: k, label: BACKGROUNDS[k] }))}
        />
      </Group>

      {cfg.template !== "minimal" && cfg.template !== "quote" && (
        <Group label="Eyebrow">
          <TextInput value={cfg.eyebrow} onChange={(v) => set({ eyebrow: v })} placeholder="RELEASE" />
        </Group>
      )}

      {cfg.template !== "minimal" && (
        <Group label="Headline">
          <TextArea value={cfg.headline} onChange={(v) => set({ headline: v })} rows={2} />
        </Group>
      )}

      <Group label={cfg.template === "minimal" ? "Tagline" : "Subhead"}>
        <TextArea value={cfg.subhead} onChange={(v) => set({ subhead: v })} rows={2} />
      </Group>

      <Group label="Version">
        <TextInput value={cfg.version} onChange={(v) => set({ version: v })} placeholder="v0.4.9" />
        <Toggle label="Show version badge" checked={cfg.showVersion} onChange={(v) => set({ showVersion: v })} />
      </Group>

      <Toggle label="Show logo lockup" checked={cfg.showLogo} onChange={(v) => set({ showLogo: v })} />
    </div>
  );
}
