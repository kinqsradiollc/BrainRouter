/**
 * Atlas view — shared internal helpers.
 *
 * Node-type sets + tiny path utilities used across the atlasView sibling
 * modules. Internal only (not re-exported from the barrel).
 */
import type { AtlasNodeType } from "@kinqs/brainrouter-types";

/** Node types shown in the structural map (symbols — function/class — are detail, hidden here). */
export const FILE_LEVEL: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>([
  "file", "config", "document", "resource", "schema", "service", "endpoint", "pipeline", "module",
]);

/** File-level node types rendered as boxes (symbols stay in the detail card). */
export const GROUPABLE: ReadonlySet<AtlasNodeType> = new Set<AtlasNodeType>([
  "file", "config", "document", "resource", "schema", "service", "endpoint", "pipeline", "module",
]);

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
