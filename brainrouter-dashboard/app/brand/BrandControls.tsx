"use client";

import type { CSSProperties } from "react";
import {
  SIZES,
  THEMES,
  ACCENTS,
  BACKGROUNDS,
  TEMPLATES,
  LOCKUPS,
  ROLES,
  AVATAR_SHAPES,
  RINGS,
  type BrandConfig,
  type Mode,
  type PresetKey,
  type ThemeKey,
  type AccentKey,
  type BgKey,
  type TemplateKey,
  type LockupKey,
  type RoleKey,
  type AvatarShape,
  type RingKey,
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
      style={{ width: "100%", padding: "9px 12px", borderRadius: "var(--radius-control)", background: "var(--surface-overlay)", border: "1px solid var(--border)", color: "var(--text)", fontSize: "13px", fontFamily: "var(--font-sans)", outline: "none" }}
    />
  );
}

function TextArea({ value, onChange, rows = 2 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: "100%", padding: "9px 12px", borderRadius: "var(--radius-control)", background: "var(--surface-overlay)", border: "1px solid var(--border)", color: "var(--text)", fontSize: "13px", lineHeight: 1.5, fontFamily: "var(--font-sans)", outline: "none", resize: "vertical" }}
    />
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "8px 12px", borderRadius: "var(--radius-control)", background: "var(--surface-overlay)", border: "1px solid var(--border)", color: "var(--text-secondary)", cursor: "pointer", fontSize: "13px" }}
    >
      <span>{label}</span>
      <span style={{ width: "34px", height: "20px", borderRadius: "9999px", background: checked ? "var(--accent)" : "var(--border-strong)", position: "relative", transition: "background 0.15s ease", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: "2px", left: checked ? "16px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "#fff", transition: "left 0.15s ease" }} />
      </span>
    </button>
  );
}

function Swatches({ value, onChange, themeAccent }: { value: AccentKey; onChange: (v: AccentKey) => void; themeAccent: string }) {
  return (
    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
      {(Object.keys(ACCENTS) as AccentKey[]).map((k) => {
        const hex = ACCENTS[k].hex || themeAccent;
        const active = k === value;
        return (
          <button
            key={k}
            type="button"
            title={ACCENTS[k].label}
            onClick={() => onChange(k)}
            style={{ width: "26px", height: "26px", borderRadius: "50%", background: hex, border: "2px solid var(--surface-raised)", boxShadow: active ? "0 0 0 2px var(--accent)" : "0 0 0 1px var(--border)", cursor: "pointer", padding: 0 }}
          />
        );
      })}
    </div>
  );
}

function Upload({ imageDataUrl, set }: { imageDataUrl: string | null; set: (p: Partial<BrandConfig>) => void }) {
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1024;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const cw = Math.round(img.width * scale);
        const ch = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, cw, ch);
        set({ imageDataUrl: canvas.toDataURL("image/jpeg", 0.92) });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };
  return (
    <div style={{ display: "flex", gap: "8px" }}>
      <label style={{ flex: 1, textAlign: "center", padding: "10px 12px", borderRadius: "var(--radius-control)", background: "var(--accent-wash)", border: "1px solid var(--border-hover-accent)", color: "var(--accent)", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
        {imageDataUrl ? "Replace photo" : "Upload photo"}
        <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
      </label>
      {imageDataUrl && (
        <button type="button" onClick={() => set({ imageDataUrl: null })} style={{ padding: "10px 14px", borderRadius: "var(--radius-control)", background: "var(--surface-overlay)", border: "1px solid var(--border)", color: "var(--text-secondary)", fontSize: "13px", cursor: "pointer" }}>
          Remove
        </button>
      )}
    </div>
  );
}

const roleOpts = (Object.keys(ROLES) as RoleKey[]).map((k) => ({ v: k, label: ROLES[k] }));

export function BrandControls({ cfg, set }: { cfg: BrandConfig; set: (patch: Partial<BrandConfig>) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <Group label="Asset type">
        <Segmented<Mode>
          cols={3}
          value={cfg.mode}
          onChange={(v) => set({ mode: v })}
          options={[
            { v: "poster", label: "Poster" },
            { v: "avatar", label: "Avatar" },
            { v: "logo", label: "Logo" },
          ]}
        />
      </Group>

      {/* ───────── POSTER ───────── */}
      {cfg.mode === "poster" && (
        <>
          <Group label="Social formats">
            <Segmented<PresetKey>
              cols={1}
              value={cfg.preset}
              onChange={(v) => set({ preset: v })}
              options={(Object.keys(SIZES) as PresetKey[]).filter((k) => SIZES[k].group === "Social").map((k) => ({ v: k, label: SIZES[k].label, note: SIZES[k].note }))}
            />
          </Group>
          <Group label="Banner & cover formats">
            <Segmented<PresetKey>
              cols={1}
              value={cfg.preset}
              onChange={(v) => set({ preset: v })}
              options={(Object.keys(SIZES) as PresetKey[]).filter((k) => SIZES[k].group === "Banner").map((k) => ({ v: k, label: SIZES[k].label, note: SIZES[k].note }))}
            />
          </Group>

          <Group label="Template">
            <Segmented<TemplateKey> value={cfg.template} onChange={(v) => set({ template: v })} options={(Object.keys(TEMPLATES) as TemplateKey[]).map((k) => ({ v: k, label: TEMPLATES[k] }))} />
          </Group>

          {cfg.template !== "quote" && cfg.template !== "minimal" && (
            <Group label="Alignment">
              <Segmented<"left" | "center"> value={cfg.align} onChange={(v) => set({ align: v })} options={[{ v: "left", label: "Left" }, { v: "center", label: "Center" }]} />
            </Group>
          )}

          <Group label="Logo lockup">
            <Segmented<LockupKey> cols={3} value={cfg.lockup} onChange={(v) => set({ lockup: v })} options={(Object.keys(LOCKUPS) as LockupKey[]).map((k) => ({ v: k, label: LOCKUPS[k] }))} />
          </Group>

          <Group label="Background">
            <Segmented<BgKey> cols={3} value={cfg.background} onChange={(v) => set({ background: v })} options={(Object.keys(BACKGROUNDS) as BgKey[]).map((k) => ({ v: k, label: BACKGROUNDS[k] }))} />
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

          <Group label="Role badge">
            <Segmented<RoleKey> cols={3} value={cfg.role} onChange={(v) => set({ role: v })} options={roleOpts} />
          </Group>
        </>
      )}

      {/* ───────── AVATAR ───────── */}
      {cfg.mode === "avatar" && (
        <>
          <Group label="Profile photo">
            <Upload imageDataUrl={cfg.imageDataUrl} set={set} />
          </Group>
          <Group label="Shape">
            <Segmented<AvatarShape> cols={3} value={cfg.avatarShape} onChange={(v) => set({ avatarShape: v })} options={(Object.keys(AVATAR_SHAPES) as AvatarShape[]).map((k) => ({ v: k, label: AVATAR_SHAPES[k] }))} />
          </Group>
          <Group label="Ring style">
            <Segmented<RingKey> cols={2} value={cfg.ring} onChange={(v) => set({ ring: v })} options={(Object.keys(RINGS) as RingKey[]).map((k) => ({ v: k, label: RINGS[k] }))} />
          </Group>
          <Group label={`Ring thickness · ${cfg.ringWidth}`}>
            <input type="range" min={1} max={10} value={cfg.ringWidth} onChange={(e) => set({ ringWidth: Number(e.target.value) })} style={{ width: "100%", accentColor: "var(--accent)" }} />
          </Group>
          <Group label="Role badge">
            <Segmented<RoleKey> cols={3} value={cfg.role} onChange={(v) => set({ role: v })} options={roleOpts} />
          </Group>
          <Toggle label="Transparent background" checked={cfg.avatarTransparent} onChange={(v) => set({ avatarTransparent: v })} />
        </>
      )}

      {/* ───────── LOGO ───────── */}
      {cfg.mode === "logo" && (
        <>
          <Group label="Lockup">
            <Segmented<LockupKey> cols={1} value={cfg.lockup} onChange={(v) => set({ lockup: v })} options={(Object.keys(LOCKUPS) as LockupKey[]).map((k) => ({ v: k, label: LOCKUPS[k] }))} />
          </Group>
          <Group label="Size">
            <Segmented<string> cols={3} value={String(cfg.logoSize)} onChange={(v) => set({ logoSize: Number(v) })} options={[{ v: "256", label: "256" }, { v: "512", label: "512" }, { v: "1024", label: "1024" }]} />
          </Group>
          <Toggle label="Transparent background" checked={cfg.logoTransparent} onChange={(v) => set({ logoTransparent: v })} />
        </>
      )}

      {/* ───────── shared look ───────── */}
      <Group label="Theme">
        <Segmented<ThemeKey> cols={3} value={cfg.theme} onChange={(v) => set({ theme: v })} options={(Object.keys(THEMES) as ThemeKey[]).map((k) => ({ v: k, label: THEMES[k].label }))} />
      </Group>
      <Group label="Accent">
        <Swatches value={cfg.accent} onChange={(v) => set({ accent: v })} themeAccent={THEMES[cfg.theme].accent} />
      </Group>
    </div>
  );
}
