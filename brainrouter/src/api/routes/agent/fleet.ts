import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, scopedUserId, errorStatus, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";

/**
 * HONK-H3.3 — the dashboard fleet console reads here. The fleet runs client-side;
 * `brainrouter fleet push` uploads a snapshot per host (the `fleet_snapshot_put`
 * MCP tool), and the dashboard renders what this returns. Tenant-scoped.
 */
export const fleetRouter = Router();
fleetRouter.use(requireAnyAuth);

/**
 * GET /api/fleet/snapshots
 * Returns the authenticated user's stored fleet snapshots (one per host),
 * most-recently-updated first: { hosts: [{ host, snapshot, jobCount, updatedAt }] }.
 */
fleetRouter.get("/snapshots", async (req: AuthedRequest, res) => {
  try {
    const userId = scopedUserId(req, req.query.userId, "fleet");
    const hosts = await memoryEngine.store.getFleetSnapshots(userId);
    res.json({ hosts });
  } catch (error) {
    sendError(res, errorStatus(error, 500), error instanceof Error ? error.message : "Failed to fetch fleet snapshots");
  }
});
