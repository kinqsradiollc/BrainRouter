/**
 * Service-port detection (ADR-008, Wave 3) — a deterministic, LLM-free analyzer
 * that finds the typed service ports (`<module>/service.ts`, plus the provider
 * `gateway.ts`) in an Atlas graph and groups them by module. This is the data
 * layer a service-level Atlas view renders ("group by module/port"), derived the
 * same build-time way as the structural layers (ATLAS-17) — no enrichment needed.
 *
 * Purely additive: it reads an existing AtlasGraph and returns a new summary; it
 * does not mutate the graph, the build pipeline, or any node. The Atlas UI wiring
 * that renders this is a separate, review-gated step.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";

/** One detected service-port facade. */
export interface ServicePort {
  /** Module the port belongs to, e.g. `"exec"`, `"provider"`, `"memory/tree"`. */
  module: string;
  /** The port file's node id (a file-level node). */
  nodeId: string;
  /** Workspace-relative path to the port file. */
  path: string;
}

/** All service ports in a graph, plus a module → port-path index for grouping. */
export interface ServicePortMap {
  ports: ServicePort[];
  byModule: Record<string, string>;
}

/** A service-port facade file: `service.ts`, or the provider `gateway.ts`. */
const SERVICE_FILE = /(?:^|\/)(?:service|gateway)\.ts$/;

/** True when a path is a service-port facade file (not a `*-service.test.ts`). */
export function isServicePortPath(path: string): boolean {
  return SERVICE_FILE.test(path);
}

/**
 * The module a port file belongs to: the directory path after the package's
 * `src/`, minus the filename. `packages/core/src/exec/service.ts` → `"exec"`;
 * `brainrouter/src/memory/tree/service.ts` → `"memory/tree"`.
 */
export function moduleForServicePath(path: string): string {
  // Strip everything up to and including the package's `src/` — whether `src/`
  // is at the start (`src/exec/service.ts`) or behind a prefix
  // (`packages/core/src/exec/service.ts`).
  const afterSrc = path.replace(/^(?:.*\/)?src\//, "");
  return afterSrc.replace(/\/(?:service|gateway)\.ts$/, "");
}

/**
 * Detect every service-port facade in an atlas graph, grouped by module.
 * Deterministic and side-effect-free. Only file-level nodes are considered, so a
 * symbol that happens to share the port's path is never double-counted.
 */
export function detectServicePorts(graph: AtlasGraph): ServicePortMap {
  const ports: ServicePort[] = [];
  const byModule: Record<string, string> = {};
  for (const node of graph.nodes) {
    const filePath = node.filePath;
    if (node.type !== "file" || !filePath || !isServicePortPath(filePath)) continue;
    const module = moduleForServicePath(filePath);
    ports.push({ module, nodeId: node.id, path: filePath });
    byModule[module] = filePath;
  }
  ports.sort((a, b) => a.module.localeCompare(b.module));
  return { ports, byModule };
}
