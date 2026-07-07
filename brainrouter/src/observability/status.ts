/**
 * System status aggregation (the single-gateway status surface, à la a public
 * status page). One process — the unified brain gateway — fronts every plane
 * (REST, MCP, dashboard), so ONE `/api/status` endpoint can report the health of
 * every component behind it. Pure + probe-injected so it unit-tests without a DB.
 */
import { VERSION } from "../version.js";

export type ComponentStatus = "operational" | "degraded" | "down";

export interface StatusComponent {
  id: string;
  label: string;
  status: ComponentStatus;
  detail?: string;
}

export interface SystemStatus {
  /** Worst-of the components — the headline state. */
  status: ComponentStatus;
  version: string;
  service: string;
  uptimeSec: number;
  checkedAt: string;
  components: StatusComponent[];
}

const RANK: Record<ComponentStatus, number> = { operational: 0, degraded: 1, down: 2 };

/** The worst component state wins (down > degraded > operational). */
export function overallStatus(components: StatusComponent[]): ComponentStatus {
  return components.reduce<ComponentStatus>(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    "operational",
  );
}

export interface StatusProbes {
  /** BRAINROUTER_SERVICE — which planes this gateway process serves. */
  service: string;
  serveRest: boolean;
  serveMcp: boolean;
  /** Liveness of the backing store (never throws — returns false on failure). */
  pingDb: () => Promise<boolean>;
  uptimeSec: number;
  checkedAt: string;
  /** Which model kinds are live behind the single gateway (llm/embedding/reranker/judge). */
  modelKinds?: Record<string, boolean>;
}

/**
 * Probe every component behind the gateway and roll up an overall status. Each
 * probe is isolated — a failing probe degrades its own component, never the call.
 */
export async function collectSystemStatus(p: StatusProbes): Promise<SystemStatus> {
  const components: StatusComponent[] = [];

  // The gateway itself — if this responded, the single entrypoint is up.
  components.push({ id: "gateway", label: "API gateway", status: "operational" });

  if (p.serveRest) components.push({ id: "api", label: "REST API", status: "operational" });
  if (p.serveMcp) components.push({ id: "mcp", label: "MCP endpoint", status: "operational" });

  let db = false;
  try { db = await p.pingDb(); } catch { db = false; }
  components.push({
    id: "database",
    label: "Database (Postgres)",
    status: db ? "operational" : "down",
    detail: db ? undefined : "liveness probe failed",
  });
  components.push({
    id: "memory",
    label: "Memory engine",
    status: db ? "operational" : "degraded",
    detail: db ? undefined : "backing store unreachable",
  });

  // Model providers behind the single gateway (llm / embedding / reranker / judge).
  // "not configured" is reported as degraded (informational), never down — a
  // deployment can run with a subset configured.
  if (p.modelKinds) {
    const KIND_LABELS: Record<string, string> = {
      llm: "LLM provider", embedding: "Embedding provider",
      reranker: "Reranker provider", judge: "Judge provider",
    };
    for (const [kind, live] of Object.entries(p.modelKinds)) {
      components.push({
        id: `provider:${kind}`,
        label: KIND_LABELS[kind] ?? `${kind} provider`,
        status: live ? "operational" : "degraded",
        detail: live ? undefined : "not configured",
      });
    }
  }

  return {
    status: overallStatus(components),
    version: VERSION,
    service: p.service,
    uptimeSec: p.uptimeSec,
    checkedAt: p.checkedAt,
    components,
  };
}
