/**
 * ADR-048 S3 — keep an EXISTING codebase map tracking the code, in the background.
 *
 * A map you must remember to refresh silently rots and then misleads. When a
 * session starts on a workspace whose graph was built at another commit, the
 * deterministic base graph is rebuilt off the turn's critical path and the prior
 * enrichment (summaries/tags/complexity) is carried forward by node id — so
 * unchanged files keep their LLM summaries and no model call is ever spent here
 * (D4). Deliberately bounded:
 *
 *  - Only when a graph ALREADY exists — building from nothing stays a person's
 *    `/atlas` decision.
 *  - Only when HEAD actually moved since `project.gitCommitHash` (and only in a
 *    git repo — no HEAD, no signal, no rebuild).
 *  - Debounced per workspace: one in-flight rebuild, and a HEAD already
 *    attempted is not retried this process (a failing build must not loop).
 *  - Scheduled with `setImmediate`, so the synchronous scan runs while the turn
 *    is idle awaiting the model, not before it.
 */
import { carryForwardSummaries, type AtlasGraph } from "@kinqs/brainrouter-types";
import { gitHeadSha } from "../git/workspaceGit.js";
import { buildBaseGraph } from "./pipeline/buildGraph.js";
import { readAtlasGraphCached, saveAtlasGraph } from "./store/atlasStore.js";

/** Pure predicate: does this graph need a rebuild for the given HEAD? */
export function atlasRefreshNeeded(
  graph: AtlasGraph | null | undefined,
  headSha: string | undefined,
): boolean {
  if (!graph || !headSha) return false;
  const built = graph.project.gitCommitHash;
  if (!built) return false;
  return !headSha.startsWith(built) && !built.startsWith(headSha);
}

const inFlight = new Set<string>();
const attempted = new Map<string, string>(); // workspaceRoot → last HEAD attempted

/**
 * Rebuild the base graph in the background when the map drifted from HEAD.
 * Returns true when a rebuild was scheduled (for tests); never throws and never
 * blocks the caller — failures leave the prior graph in place, and the
 * orientation's staleness note keeps the drift honest until a rebuild lands.
 */
export function maybeRefreshAtlasInBackground(workspaceRoot: string): boolean {
  if (inFlight.has(workspaceRoot)) return false;
  const graph = readAtlasGraphCached(workspaceRoot);
  if (!graph) return false;
  const head = gitHeadSha(workspaceRoot);
  if (!atlasRefreshNeeded(graph, head)) return false;
  if (attempted.get(workspaceRoot) === head) return false;
  inFlight.add(workspaceRoot);
  attempted.set(workspaceRoot, head!);
  setImmediate(() => {
    try {
      const fresh = buildBaseGraph(workspaceRoot);
      saveAtlasGraph(workspaceRoot, carryForwardSummaries(fresh, graph));
    } catch {
      // Advisory: the stale graph (with its honest drift note) beats no graph.
    } finally {
      inFlight.delete(workspaceRoot);
    }
  });
  return true;
}
