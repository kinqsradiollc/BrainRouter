/**
 * Service map (ADR-008, Wave 3) — read the codebase as the decomposed service
 * architecture: each module that exposes a typed PORT (`<module>/service.ts`, or
 * the provider `gateway.ts`) becomes a service card, wired by the imports that
 * cross module boundaries. Deterministic + build-time — no enrichment needed —
 * so the multi-service decomposition self-documents in Atlas.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { GROUPABLE, dirOf } from "./shared.js";

/** A service-port facade file: `service.ts`, or the provider `gateway.ts`. */
const SERVICE_FILE_RE = /(?:^|\/)(?:service|gateway)\.ts$/;

/** True when a path is a service-port facade (not a `*-service.test.ts`). */
export function isServicePortPath(path: string): boolean {
  return SERVICE_FILE_RE.test(path);
}

/** Readable module label: the directory after the package's `src/`, minus the filename. */
export function serviceModuleLabel(path: string): string {
  return path.replace(/^(?:.*\/)?src\//, "").replace(/\/(?:service|gateway)\.ts$/, "");
}

export interface AtlasServiceCard {
  /** `service:<dir>` — the port file's directory. */
  id: string;
  /** Readable module name, e.g. `"exec"`, `"memory/tree"`. */
  module: string;
  /** Workspace-relative path to the port file. */
  portPath: string;
  /** The port file's node id (for selection / detail). */
  portNodeId: string;
  /** File-level nodes that make up the module (same directory as the port). */
  nodeIds: string[];
  fileCount: number;
}

export interface AtlasServiceModel {
  cards: AtlasServiceCard[];
  /** Directed module→module import edges (source imports target), weighted. */
  edges: Array<{ source: string; target: string; weight: number }>;
}

/**
 * Service cards (one per module exposing a port) + the directed import edges
 * between them. A file belongs to the module of the port file in its directory.
 * Pure + deterministic; file-level nodes only (a symbol sharing the port's path
 * is never double-counted).
 */
export function atlasServiceModel(graph: AtlasGraph): AtlasServiceModel {
  const ports = graph.nodes.filter(
    (n) => GROUPABLE.has(n.type) && n.filePath && isServicePortPath(n.filePath),
  );

  const cards: AtlasServiceCard[] = [];
  const seenDir = new Set<string>();
  const fileModule = new Map<string, string>(); // file node id → card id

  for (const port of ports) {
    const dir = dirOf(port.filePath!);
    if (seenDir.has(dir)) continue; // one card per module dir (first port wins)
    seenDir.add(dir);
    const id = `service:${dir}`;
    const members = graph.nodes.filter(
      (n) => GROUPABLE.has(n.type) && n.filePath && dirOf(n.filePath) === dir,
    );
    members.forEach((m) => fileModule.set(m.id, id));
    cards.push({
      id,
      module: serviceModuleLabel(port.filePath!),
      portPath: port.filePath!,
      portNodeId: port.id,
      nodeIds: members.map((m) => m.id),
      fileCount: members.length,
    });
  }

  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const a = fileModule.get(e.source);
    const b = fileModule.get(e.target);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const edges = [...counts.entries()].map(([k, weight]) => {
    const [source, target] = k.split(" ");
    return { source, target, weight };
  });

  cards.sort((a, b) => a.module.localeCompare(b.module));
  return { cards, edges };
}
