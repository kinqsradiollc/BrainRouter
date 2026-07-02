/**
 * Atlas view — theme-consistent colours.
 *
 * Node-type + file-category colour maps (tuned for the near-black Graphite
 * theme) plus the file-category display order for the filter pills.
 */
import type { AtlasFileCategory, AtlasNodeType } from "@kinqs/brainrouter-types";

/**
 * Node-type colours, tuned for the near-black Graphite theme (indigo accent for
 * code files, a restrained spread for the rest — NOT a loud rainbow). Consumed
 * inline so they track the active theme's accent where it matters.
 */
export const ATLAS_NODE_COLORS: Record<string, string> = {
  file: "var(--accent, #4c8dff)",
  module: "#7c93ff",
  config: "#2dd4bf",
  document: "#38bdf8",
  resource: "#fbbf24",
  schema: "#34d399",
  service: "#a78bfa",
  endpoint: "#fb923c",
  pipeline: "#f472b6",
  function: "#5fae74",
  class: "#9b7fc0",
  domain: "#e0a458",
  flow: "#7dd3fc",
  step: "#94a3b8",
};

export function atlasNodeColor(type: AtlasNodeType): string {
  return ATLAS_NODE_COLORS[type] ?? "var(--text-dim, #9d9da6)";
}

/** The file categories shown as filter pills, in display order. */
export const ATLAS_FILE_CATEGORIES: readonly AtlasFileCategory[] = ["code", "config", "docs", "infra", "data", "markup", "script"];

export const ATLAS_CATEGORY_COLORS: Record<AtlasFileCategory, string> = {
  code: "var(--accent, #4c8dff)",
  config: "#2dd4bf",
  docs: "#38bdf8",
  infra: "#a78bfa",
  data: "#34d399",
  markup: "#fbbf24",
  script: "#fb923c",
};
