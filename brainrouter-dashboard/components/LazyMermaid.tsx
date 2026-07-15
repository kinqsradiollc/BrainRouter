"use client";

import dynamic from "next/dynamic";

/** Mermaid is only needed after a working-memory canvas exists. */
export const LazyMermaid = dynamic(
  () => import("./Mermaid").then((module) => module.Mermaid),
  {
    ssr: false,
    loading: () => <div className="settings-empty-inline">Rendering diagram…</div>,
  },
);
