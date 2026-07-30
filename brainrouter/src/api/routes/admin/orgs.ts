/**
 * Admin console (ADR-014 Phase F). System-admin oversight of every Team: plan,
 * seats used vs the plan limit, project count, and owner. Admin-only.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireJwt, requireAdmin } from "../../middleware/auth.js";
import { entitlementsFor } from "../../../tenancy/entitlements.js";

export const adminOrgsRouter = Router();
adminOrgsRouter.use(requireJwt, requireAdmin);

/** GET /api/admin/orgs — every Team with seat/project usage against its plan. */
adminOrgsRouter.get("/", async (_req, res) => {
  const orgs = await memoryEngine.adminConsole.listAllOrgsWithStats();
  const rows = orgs.map((o) => {
    const ents = entitlementsFor(o.plan);
    return {
      ...o,
      seatLimit: ents.limits.seats,
      projectLimit: ents.limits.projects,
      overSeats: ents.limits.seats !== null && o.memberCount > ents.limits.seats,
    };
  });
  res.json({ orgs: rows, total: rows.length });
});
