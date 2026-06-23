/**
 * Atlas service (ADR-008, Wave 2) — a per-workspace port over the codebase
 * knowledge-graph capability: scan → build → enrich → validate → persist.
 * `workspaceRoot` is bound at construction (and used as the scan/build root).
 * Additive and behaviour-preserving: every method delegates to the existing atlas
 * functions. No logic moved or removed.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { atlasGraphFile, saveAtlasGraph, readAtlasGraph, atlasGraphStats } from "./atlasStore.js";
import { buildBaseGraph, type BuildOptions } from "./buildGraph.js";
import { scanWorkspace, type ScanOptions, type ScanResult } from "./scan.js";
import { enrichAtlasGraph, type AtlasLlmCaller, type EnrichOptions, type EnrichResult } from "./enrich.js";
import { validateAtlasGraph, type AtlasValidation } from "./validate.js";

/** Aggregate returned by {@link IAtlasService.stats}. */
export type AtlasGraphStats = ReturnType<typeof atlasGraphStats>;

/** The codebase knowledge-graph contract, scoped to one workspace. */
export interface IAtlasService {
  graphFile(): string;
  read(): AtlasGraph | null;
  save(graph: AtlasGraph): void;
  stats(graph: AtlasGraph): AtlasGraphStats;
  scan(opts?: ScanOptions): ScanResult;
  build(opts?: BuildOptions): AtlasGraph;
  enrich(graph: AtlasGraph, llm: AtlasLlmCaller, opts?: EnrichOptions): Promise<EnrichResult>;
  validate(graph: AtlasGraph): AtlasValidation;
}

/** {@link IAtlasService} backed by the in-process atlas pipeline — delegates only. */
export class AtlasService implements IAtlasService {
  constructor(private readonly workspaceRoot: string) {}
  graphFile(): string {
    return atlasGraphFile(this.workspaceRoot);
  }
  read(): AtlasGraph | null {
    return readAtlasGraph(this.workspaceRoot);
  }
  save(graph: AtlasGraph): void {
    return saveAtlasGraph(this.workspaceRoot, graph);
  }
  stats(graph: AtlasGraph): AtlasGraphStats {
    return atlasGraphStats(graph);
  }
  scan(opts?: ScanOptions): ScanResult {
    return opts === undefined ? scanWorkspace(this.workspaceRoot) : scanWorkspace(this.workspaceRoot, opts);
  }
  build(opts?: BuildOptions): AtlasGraph {
    return opts === undefined ? buildBaseGraph(this.workspaceRoot) : buildBaseGraph(this.workspaceRoot, opts);
  }
  enrich(graph: AtlasGraph, llm: AtlasLlmCaller, opts?: EnrichOptions): Promise<EnrichResult> {
    return opts === undefined ? enrichAtlasGraph(graph, llm) : enrichAtlasGraph(graph, llm, opts);
  }
  validate(graph: AtlasGraph): AtlasValidation {
    return validateAtlasGraph(graph);
  }
}

/** Construct an atlas service bound to a workspace. */
export function createAtlasService(workspaceRoot: string): IAtlasService {
  return new AtlasService(workspaceRoot);
}
