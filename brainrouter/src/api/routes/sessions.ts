import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

/**
 * Federation Stage 2 (FED-S2-T7) — dashboard view onto the
 * `active_sessions` registry. Read-only; mutations go through the
 * MCP tools (`session_register` / `session_heartbeat`) so the brain
 * is the single owner of the registry contract.
 *
 * Query params:
 *   - `clientKind` (string)        — filter by client kind.
 *   - `workspaceRoot` (string)     — filter by workspace.
 *   - `includeStale` (boolean str) — default false (only ≤2 min heartbeats).
 *   - `includeUsage` (boolean str) — default false; opt in to FED-S2-T8 telemetry.
 *   - `staleThresholdMs` (number) — override the 2-min default.
 */
export const sessionsRouter = Router();
sessionsRouter.use(requireAnyAuth);

function parseBool(value: unknown): boolean | undefined {
  if (typeof value !== "string") return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

sessionsRouter.get("/", (req: AuthedRequest, res) => {
  const clientKind = typeof req.query.clientKind === "string" ? req.query.clientKind : undefined;
  const workspaceRoot =
    typeof req.query.workspaceRoot === "string" ? req.query.workspaceRoot : undefined;
  const includeStale = parseBool(req.query.includeStale);
  const includeUsage = parseBool(req.query.includeUsage);
  const staleThresholdMs =
    typeof req.query.staleThresholdMs === "string" ? Number(req.query.staleThresholdMs) : undefined;
  const sessions = memoryEngine.store.listActiveSessions({
    userId: req.userId!,
    clientKind,
    workspaceRoot,
    includeStale,
    staleThresholdMs:
      typeof staleThresholdMs === "number" && Number.isFinite(staleThresholdMs)
        ? staleThresholdMs
        : undefined,
    includeUsage,
  });
  res.json({ sessions });
});
