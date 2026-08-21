/**
 * ADR-041 D14 (glass box, commitment #5) — composition transparency over HTTP.
 *
 * `runtimeCompositionSnapshot()` is the same pure projection `--dump-composition`
 * prints: the built-in tools, the migrated (D8) handler set, the live provider
 * registry, extension contributions, slash commands, the runtime-invariant areas
 * (with any live violations), and the active loop-driver / execution-world rows.
 * This route makes it visible in the dashboard so an operator can see *what is
 * running* — the plugin-inventory half of D14's "show what is running / show what
 * it can do" pair. Read-only; admin-gated like the other runtime-settings reads.
 */
import { Router } from "express";
import { runtimeCompositionSnapshot } from "@kinqs/brainrouter-core/runtime";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";

export const runtimeCompositionRouter = Router();
runtimeCompositionRouter.use(requireAnyAuth, requirePermission("providers:manage"));

/** GET /api/admin/runtime/composition — the resolved runtime composition snapshot. */
runtimeCompositionRouter.get("/composition", (_req: AuthedRequest, res) => {
  res.json(runtimeCompositionSnapshot());
});
