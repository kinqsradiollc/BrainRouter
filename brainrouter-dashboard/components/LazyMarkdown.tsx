"use client";

import dynamic from "next/dynamic";

/**
 * React Markdown + KaTeX is a sizeable parser stack. Keep it out of the route's
 * critical bundle and hydrate it only on surfaces that actually have prose to
 * render (chat messages, persona text, expanded scene summaries).
 */
export const LazyMarkdown = dynamic(
  () => import("./Markdown").then((module) => module.Markdown),
  {
    ssr: false,
    loading: () => <span className="markdown-loading" aria-label="Formatting content">Formatting…</span>,
  },
);
