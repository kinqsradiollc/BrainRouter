/**
 * Screens map (UI-TEST fusion) — the app's *runtime* interaction map rendered as
 * a first-class Atlas mode. A generated `UiMap` (data-testid extractor) turns into
 * screen CONTAINERS with their interactive elements as leaf nodes, coloured by
 * action. Kept in its OWN sub-structure (never mixed into the code graph's node
 * arrays) so the UI map cross-links to the code without polluting it. Pure.
 */
import type { AtlasGroup } from "./grouping.js";
// Type-only (erased at build) — the generated UI map the Screens mode renders.
import type { UiMap } from "@kinqs/brainrouter-core/uitest";

/** Element action → node colour for the Screens map. */
export const ATLAS_ELEMENT_COLORS: Record<string, string> = {
  tap: "var(--accent, #4c8dff)",
  type: "#34d399",
  navigate: "#a78bfa",
  assertVisible: "#94a3b8",
};

export function atlasElementColor(action: string): string {
  return ATLAS_ELEMENT_COLORS[action] ?? "var(--text-dim, #9d9da6)";
}

/** One `data-testid` element as a leaf node in the Screens map. */
export interface AtlasUiElementNode {
  /** Unique React Flow node id: `uiel:<screenId>::<elementId>`. */
  nodeId: string;
  /** The owning screen's container node id. */
  screenNodeId: string;
  testID: string;
  label?: string;
  type: string;
  action: string;
  filePath?: string;
  line?: number;
}

/** One screen as a container node in the Screens map. */
export interface AtlasUiScreenNode {
  /** Unique React Flow node id: `uiscreen:<screenId>`. */
  nodeId: string;
  screenId: string;
  title: string;
  route?: string | null;
  filePath?: string;
  elementCount: number;
}

export interface AtlasUiModel {
  /** Screen containers — feed straight into {@link atlasGroupedLayout}. */
  groups: AtlasGroup[];
  /** container node id → screen. */
  screens: Map<string, AtlasUiScreenNode>;
  /** element node id → element. */
  elements: Map<string, AtlasUiElementNode>;
  screenCount: number;
  elementCount: number;
  /** true when the extractor ran without the optional `typescript` peer. */
  degraded: boolean;
}

/**
 * Turn a generated `UiMap` into the Atlas "Screens" view model: one group per
 * screen (its title labels the container) whose `nodeIds` are its elements'
 * synthetic node ids, plus lookup maps the panel uses to render + cross-link.
 * Element ids are namespaced by screen so the same `testID` on two screens stays
 * distinct. Pure + tested.
 */
export function atlasUiModel(uiMap: UiMap | null | undefined): AtlasUiModel {
  const groups: AtlasGroup[] = [];
  const screens = new Map<string, AtlasUiScreenNode>();
  const elements = new Map<string, AtlasUiElementNode>();
  let elementCount = 0;

  for (const s of uiMap?.screens ?? []) {
    const screenNodeId = `uiscreen:${s.id}`;
    const nodeIds: string[] = [];
    for (const el of s.elements) {
      const nodeId = `uiel:${s.id}::${el.id}`;
      elements.set(nodeId, {
        nodeId,
        screenNodeId,
        testID: el.testID,
        label: el.label,
        type: el.type,
        action: el.action,
        filePath: el.filePath,
        line: el.line,
      });
      nodeIds.push(nodeId);
      elementCount++;
    }
    groups.push({ id: screenNodeId, label: s.title, nodeIds });
    screens.set(screenNodeId, {
      nodeId: screenNodeId,
      screenId: s.id,
      title: s.title,
      route: s.route ?? null,
      filePath: s.filePath,
      elementCount: s.elements.length,
    });
  }

  return { groups, screens, elements, screenCount: screens.size, elementCount, degraded: !!uiMap?.degraded };
}
