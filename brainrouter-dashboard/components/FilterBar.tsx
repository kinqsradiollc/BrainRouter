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
    <div className="filter-bar__row" style={{ gap: `${gap}px`, justifyContent, ...style }}>
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
    <label className="filter-bar__label">
      <span>{text}</span>
      {children}
    </label>
  );
}

export function FilterBar({ children, card = true, style }: FilterBarProps) {
  return (
    <div className={`filter-bar${card ? " filter-bar--card" : ""}`} style={style}>
      {children}
    </div>
  );
}

FilterBar.Row = FilterRow;
FilterBar.Label = FilterLabel;
