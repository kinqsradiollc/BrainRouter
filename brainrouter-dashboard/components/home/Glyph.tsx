import type { CSSProperties } from "react";

/**
 * Glyph — minimal line icons (1.5 stroke, currentColor) replacing the landing
 * page's emoji icons. Emojis read amateur/dated; these match the design language
 * (Phosphor-style, monochrome, inherit color). Size defaults to 16.
 */

type GlyphName =
  | "inbox" | "records" | "graph" | "agent" | "monitor" | "phone" | "bolt" | "snowflake";

const PATHS: Record<GlyphName, JSX.Element> = {
  inbox: (
    <>
      <path d="M3 12h5l2 3h4l2-3h5" />
      <path d="M5 6h14l2 6v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z" />
    </>
  ),
  records: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="7" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="13" cy="17" r="2" />
      <path d="M8 8l3 7M16 8l-2 7M8 7h8" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="2" />
      <path d="M12 3v4M9 12h.01M15 12h.01M9 15h6" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  bolt: <path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" />,
  snowflake: (
    <>
      <path d="M12 3v18M5 7l14 10M19 7 5 17" />
      <path d="M9 4l3 2 3-2M9 20l3-2 3 2" />
    </>
  ),
};

export function Glyph({ name, size = 16, style }: { name: GlyphName; size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={style}
    >
      {PATHS[name]}
    </svg>
  );
}
