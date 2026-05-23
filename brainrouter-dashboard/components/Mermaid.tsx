"use client";

// Mermaid diagram renderer for any Mermaid source (flowcharts, sequence,
// state, gantt, etc.). Currently used for the Working Memory canvas, but
// kept in its own component so chat / scenes / persona can render
// ```mermaid``` blocks later without duplicating the init logic.
//
// Design-system fidelity:
//   - All colors come from the dashboard's CSS variables (see globals.css
//     and BRAINROUTER_DESIGN.MD § "Tokens — Colors"). The component reads
//     them at render time via getComputedStyle, so light/dark mode and
//     any future theme tweaks flow through automatically.
//   - A MutationObserver on `html[data-theme]` re-initializes mermaid and
//     re-renders the SVG whenever the theme switches — mermaid bakes
//     colors into the SVG at render time, so we can't rely on CSS
//     cascade alone.
//   - Inter is the body face per the design doc; the diagram font follows
//     the `--font-inter` token rather than a hardcoded fallback.
//
// Implementation notes:
//   - "Use client" + useEffect because mermaid mutates the DOM.
//   - `mermaid.initialize` is global; we call it before each render so
//     theme-token updates take effect, but the cost is negligible.
//   - Errors get caught and shown as a fallback `<pre>` block styled with
//     the same tokens so a malformed diagram never blanks the surface.

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

interface DesignTokens {
  primaryColor: string;
  primaryTextColor: string;
  primaryBorderColor: string;
  lineColor: string;
  secondaryColor: string;
  tertiaryColor: string;
  fontFamily: string;
}

// SSR-safe defaults match the dark-theme token values from globals.css.
// Used until the component mounts and can read the real CSS variables.
const FALLBACK_DARK: DesignTokens = {
  primaryColor: "#1c1d22", // --color-slate-gray (Surface level 4)
  primaryTextColor: "#e2e3e9", // --color-white-frost
  primaryBorderColor: "#5e616e", // --color-ash-text
  lineColor: "#777a88", // --color-stone-text
  secondaryColor: "#121317", // --color-pewter-accent (Surface level 3)
  tertiaryColor: "#08080a", // --color-charcoal-canvas (Surface level 2)
  fontFamily: "'Inter', system-ui, sans-serif",
};

function readDesignTokens(): DesignTokens {
  if (typeof window === "undefined") return FALLBACK_DARK;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    primaryColor: get("--color-slate-gray", FALLBACK_DARK.primaryColor),
    primaryTextColor: get("--color-white-frost", FALLBACK_DARK.primaryTextColor),
    primaryBorderColor: get("--color-ash-text", FALLBACK_DARK.primaryBorderColor),
    lineColor: get("--color-stone-text", FALLBACK_DARK.lineColor),
    secondaryColor: get("--color-pewter-accent", FALLBACK_DARK.secondaryColor),
    tertiaryColor: get("--color-charcoal-canvas", FALLBACK_DARK.tertiaryColor),
    fontFamily: get("--font-inter", FALLBACK_DARK.fontFamily),
  };
}

function initMermaid(tokens: DesignTokens) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // `base` lets themeVariables take full effect; the bundled "dark" theme
    // would override several of our tokens with its own palette.
    theme: "base",
    themeVariables: {
      background: "transparent",
      primaryColor: tokens.primaryColor,
      primaryTextColor: tokens.primaryTextColor,
      primaryBorderColor: tokens.primaryBorderColor,
      lineColor: tokens.lineColor,
      secondaryColor: tokens.secondaryColor,
      tertiaryColor: tokens.tertiaryColor,
      // Reinforce text colors used by sequence / state diagrams.
      secondaryTextColor: tokens.primaryTextColor,
      tertiaryTextColor: tokens.primaryTextColor,
      noteBkgColor: tokens.secondaryColor,
      noteTextColor: tokens.primaryTextColor,
      noteBorderColor: tokens.primaryBorderColor,
      // Edge labels (link text + arrow heads).
      edgeLabelBackground: tokens.tertiaryColor,
      textColor: tokens.primaryTextColor,
      fontFamily: tokens.fontFamily,
      fontSize: "13px", // Sit between --text-caption (12) and --text-body-sm (14)
    },
    flowchart: { htmlLabels: true, curve: "basis" },
  });
}

function stripFences(src: string): string {
  return src
    .trim()
    .replace(/^```(?:mermaid)?\s*\n/i, "")
    .replace(/\n```\s*$/i, "")
    .trim();
}

interface MermaidProps {
  children: string;
}

export function Mermaid({ children }: MermaidProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeNonce, setThemeNonce] = useState(0);
  const renderIdRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 11)}`);

  // Re-render whenever the user flips the theme — mermaid bakes colors into
  // the SVG, so a CSS-variable update alone would leave the diagram stuck
  // in the previous palette.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const observer = new MutationObserver(() => setThemeNonce((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    initMermaid(readDesignTokens());

    const source = stripFences(children);
    if (!source) {
      setError(null);
      if (containerRef.current) containerRef.current.innerHTML = "";
      return;
    }

    mermaid
      .render(renderIdRef.current, source)
      .then(({ svg }) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        // Clean up the placeholder Mermaid attaches to <body> on failed
        // renders, otherwise it accumulates across re-renders.
        const orphan = document.getElementById(`d${renderIdRef.current}`);
        orphan?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [children, themeNonce]);

  if (error) {
    return (
      <div
        style={{
          borderLeft: "3px solid var(--color-golden-accent)",
          paddingLeft: "12px",
          marginTop: "12px",
          fontFamily: "var(--font-inter)",
        }}
      >
        <div
          style={{
            color: "var(--color-stone-text)",
            fontSize: "12px",
            lineHeight: 1.5,
            letterSpacing: "-0.007px",
            marginBottom: "6px",
          }}
        >
          Mermaid render failed — showing source.
        </div>
        <pre
          style={{
            margin: 0,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "14px",
            lineHeight: 1.43,
            color: "var(--color-white-frost)",
            whiteSpace: "pre-wrap",
          }}
        >
          {children}
        </pre>
        <div
          style={{
            color: "var(--color-ash-text)",
            fontSize: "12px",
            lineHeight: 1.5,
            marginTop: "8px",
            fontStyle: "italic",
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      style={{
        marginTop: "12px",
        overflowX: "auto",
        display: "flex",
        justifyContent: "center",
        // Subtle elevated background — Surface level 3 (Pewter Accent),
        // matches `Card Standard` radius (10px) per the design doc.
        backgroundColor: "var(--color-pewter-accent)",
        borderRadius: "10px",
        padding: "16px",
      }}
    />
  );
}
