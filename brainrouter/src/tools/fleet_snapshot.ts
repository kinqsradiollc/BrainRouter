import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * HONK-H3.3 — fleet snapshot store-and-serve.
 *
 * The fleet runs CLIENT-side (the durable queue lives in ~/.brainrouter/fleet on
 * the host running `brainrouter fleet drain`). A remote/deployed brain can't read
 * those files, so the client PUSHES a snapshot via `fleet_snapshot_put` and the
 * dashboard (a remote client) reads them back with `fleet_snapshot_get`. The
 * snapshot is stored verbatim — the brain only relays it.
 *
 * Tenant isolation: the MCP dispatcher pins `userId` to the authenticated user,
 * and every store call is scoped by `userId`, so a client only ever touches its
 * own fleet snapshots.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

// ---- fleet_snapshot_put -------------------------------------------------

export const fleetSnapshotPutToolSchema = {
  name: "fleet_snapshot_put",
  description:
    "Store (upsert) a fleet host's queue snapshot so a remote brain / dashboard can serve it back. The snapshot is produced client-side by `brainrouter fleet`; this persists it, keyed by host. Tenant-scoped. Returns {ok, host, jobCount}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Optional; resolved from request context when absent." },
      host: { type: "string", description: "The fleet host identifier this snapshot is for." },
      snapshot: { type: "object", description: "The fleet snapshot payload (the shape `summarizeFleet()` returns)." },
      jobCount: { type: "number", description: "Total job count at push time (cheap list metadata)." },
    },
    required: ["host", "snapshot"],
  },
} as const;

const putSchema = z.object({
  userId: z.string().optional(),
  host: z.string().min(1).max(200),
  snapshot: z.unknown(),
  jobCount: z.number().int().min(0).optional(),
});

export async function handleFleetSnapshotPut(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = putSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const jobCount =
      params.jobCount ??
      (params.snapshot && typeof params.snapshot === "object" && typeof (params.snapshot as { total?: unknown }).total === "number"
        ? ((params.snapshot as { total: number }).total)
        : 0);
    await memoryEngine.store.putFleetSnapshot(userId, params.host, params.snapshot, jobCount);
    return toolResult({ ok: true, host: params.host, jobCount });
  } catch (err) {
    return toolError("fleet_snapshot_put", err);
  }
}

// ---- fleet_snapshot_get -------------------------------------------------

export const fleetSnapshotGetToolSchema = {
  name: "fleet_snapshot_get",
  description:
    "Fetch the tenant's stored fleet snapshots (one per host), most-recently-updated first — the data behind the dashboard fleet console. Tenant-scoped. Returns {hosts:[{host, snapshot, jobCount, updatedAt}]}.",
  inputSchema: {
    type: "object",
    properties: { userId: { type: "string" } },
  },
} as const;

const getSchema = z.object({ userId: z.string().optional() });

export async function handleFleetSnapshotGet(args: unknown, options?: { defaultUserId?: string }) {
  try {
    const params = getSchema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    const hosts = await memoryEngine.store.getFleetSnapshots(userId);
    return toolResult({ hosts });
  } catch (err) {
    return toolError("fleet_snapshot_get", err);
  }
}
