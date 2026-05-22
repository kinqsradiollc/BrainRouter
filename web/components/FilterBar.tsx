"use client";

import React from "react";

/**
 * Consistent layout for filter/action rows across the dashboard pages.
 *
 * Composition:
 *   <FilterBar>
 *     <FilterBar.Row>            ← horizontal cluster, wraps on small screens
 *       <input className="pill-input" … />
 *       <button className="pill-btn pill-btn-ghost">…</button>
 *     </FilterBar.Row>
 *     <FilterBar.Row align="end"> ← right-aligned cluster
 *       <button className="pill-btn">Apply</button>
 *     </FilterBar.Row>
 *   </FilterBar>
 *
 * The point is to stop each page from inventing its own flex container with
 * subtly different gap/padding values. Use this anywhere you'd otherwise type
 * `<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>`.
 */

interface FilterBarProps {
  children: React.ReactNode;
  /** Card-style container (default true) or transparent if false. */
  card?: boolean;
  /** Extra style to merge onto the wrapper. */
  style?: React.CSSProperties;
}

interface FilterRowProps {
  children: React.ReactNode;
  align?: "start" | "end" | "between";
  gap?: number;
  style?: React.CSSProperties;
}

function FilterRow({ children, align = "start", gap = 8, style }: FilterRowProps) {
  const justifyContent =
    align === "end" ? "flex-end" : align === "between" ? "space-between" : "flex-start";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: `${gap}px`,
        flexWrap: "wrap",
        justifyContent,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

interface FilterLabelProps {
  text: string;
  children: React.ReactNode;
}

/** Pair a small uppercase caption with an input/select. Stack within a row. */
function FilterLabel({ text, children }: FilterLabelProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
      <span
        style={{
          color: "var(--color-stone-text)",
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {text}
      </span>
      {children}
    </label>
  );
}

export function FilterBar({ children, card = true, style }: FilterBarProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: card ? "16px 20px" : 0,
        borderRadius: card ? "var(--radius-md)" : 0,
        background: card ? "var(--color-obsidian-surface)" : "transparent",
        border: card ? "1px solid var(--border-dim)" : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

FilterBar.Row = FilterRow;
FilterBar.Label = FilterLabel;
