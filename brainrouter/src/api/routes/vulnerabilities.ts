/**
 * CVE intelligence API (spec §10.3, Task 31). Catalog reads are global data
 * behind vulnerabilities:read; scans/findings/watches are org-scoped; source
 * refresh is vulnerabilities:manage. A scan accepts the repository's OWN
 * lockfile/manifest/SBOM contents — exposure always carries exact evidence.
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { requirePermission } from "../middleware/tenancy.js";
import { memoryEngine } from "../../memory/engine.js";
import { parseInventoryFile, SUPPORTED_INVENTORY_FILES } from "../../vulnerability/inventory.js";
import { matchInventoryAgainstOsv, OSV_SOURCE } from "../../vulnerability/osv.js";
import { syncNvd } from "../../vulnerability/nvd.js";
import { syncKev, syncEpss } from "../../vulnerability/enrichment.js";
import type { InventoryComponent } from "../../vulnerability/types.js";
import type { NvdSyncStore } from "../../vulnerability/nvd.js";
import type { EnrichmentStore } from "../../vulnerability/enrichment.js";

type CatalogStore = NvdSyncStore & EnrichmentStore & {
  listVulnerabilities(filters: Record<string, unknown>): Promise<{ items: unknown[]; total: number }>;
  getVulnerability(cveId: string): Promise<unknown | null>;
  listVulnerabilitySources(): Promise<unknown[]>;
  createVulnerabilityScan(input: { orgId: string; userId: string; repo: string }): Promise<{ id: string }>;
  finishVulnerabilityScan(orgId: string, scanId: string, outcome: { status: "succeeded" | "failed"; componentsSeen: number; matchesFound: number; truncated: boolean; error?: string }): Promise<void>;
  getVulnerabilityScan(orgId: string, scanId: string): Promise<unknown | null>;
  listVulnerabilityScans(orgId: string, limit?: number): Promise<unknown[]>;
  replaceAssetComponents(orgId: string, repo: string, scanId: string, components: InventoryComponent[]): Promise<void>;
  listVulnerabilityMatches(orgId: string, filters?: { repo?: string; status?: string; limit?: number }): Promise<Array<{ cveId: string }>>;
  upsertVulnerabilityMatch(orgId: string, repo: string, scanId: string, match: import("../../vulnerability/types.js").VulnerabilityMatch): Promise<void>;
  setVulnerabilityMatchStatus(orgId: string, matchId: string, status: "open" | "dismissed", reason?: string): Promise<boolean>;
  upsertVulnerabilityWatch(input: { orgId: string; userId: string; repo: string }): Promise<{ id: string }>;
  listVulnerabilityWatches(orgId: string): Promise<unknown[]>;
  deleteVulnerabilityWatch(orgId: string, watchId: string): Promise<boolean>;
};
const store = (): CatalogStore => memoryEngine.store as unknown as CatalogStore;

export const vulnerabilitiesRouter = Router();
vulnerabilitiesRouter.use(requireAnyAuth);

/** Catalog list — server-paginated; filters mirror the dashboard's URL params. */
vulnerabilitiesRouter.get("/", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  const q = req.query;
  const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const result = await store().listVulnerabilities({
    search: typeof q.search === "string" ? q.search.slice(0, 200) : undefined,
    severity: typeof q.severity === "string" ? q.severity : undefined,
    kevOnly: q.kev === "true",
    minCvss: num(q.minCvss),
    minEpss: num(q.minEpss),
    ecosystem: typeof q.ecosystem === "string" ? q.ecosystem : undefined,
    modifiedSince: typeof q.modifiedSince === "string" ? q.modifiedSince : undefined,
    limit: num(q.limit),
    offset: num(q.offset),
  });
  res.json(result);
});

vulnerabilitiesRouter.get("/sources", requirePermission("vulnerabilities:read"), async (_req: AuthedRequest, res) => {
  res.json({ sources: await store().listVulnerabilitySources() });
});

/** Manual source refresh (manage) — bounded inline run; freshness stays visible. */
vulnerabilitiesRouter.post("/sources/:id/refresh", requirePermission("vulnerabilities:manage"), async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  try {
    if (id === "nvd") { res.json(await syncNvd({ store: store() })); return; }
    if (id === "cisa-kev") { res.json(await syncKev({ store: store() })); return; }
    if (id === "first-epss") {
      const matches = await store().listVulnerabilityMatches(req.orgId!, { limit: 500 });
      res.json(await syncEpss({ store: store(), cveIds: matches.map((m) => m.cveId) }));
      return;
    }
    res.status(404).json({ error: `Unknown source "${id}"` });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Source refresh failed" });
  }
});

/** Manual repository scan: exact lockfile/manifest/SBOM contents in, matches out. */
vulnerabilitiesRouter.post("/scans", requirePermission("vulnerabilities:scan"), async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as { repo?: unknown; files?: unknown };
  const repo = typeof body.repo === "string" ? body.repo.trim().slice(0, 200) : "";
  const files = Array.isArray(body.files) ? body.files as Array<{ path?: unknown; content?: unknown }> : [];
  if (!repo || files.length === 0) {
    res.status(400).json({ error: `repo and files are required (supported: ${SUPPORTED_INVENTORY_FILES.join(", ")})` });
    return;
  }
  const scan = await store().createVulnerabilityScan({ orgId: req.orgId!, userId: req.userId!, repo });
  try {
    const components: InventoryComponent[] = [];
    for (const file of files.slice(0, 20)) {
      if (typeof file.path !== "string" || typeof file.content !== "string" || file.content.length > 8 * 1024 * 1024) continue;
      components.push(...parseInventoryFile(file.path, file.content));
    }
    await store().ensureVulnerabilitySource(OSV_SOURCE as never);
    const result = await matchInventoryAgainstOsv(components);
    await store().replaceAssetComponents(req.orgId!, repo, scan.id, components);
    for (const observation of result.observations) await store().upsertVulnerabilityObservation(observation);
    for (const match of result.matches) await store().upsertVulnerabilityMatch(req.orgId!, repo, scan.id, match);
    await store().finishVulnerabilityScan(req.orgId!, scan.id, {
      status: "succeeded", componentsSeen: components.length, matchesFound: result.matches.length, truncated: result.truncated,
    });
    res.status(201).json({ scan: await store().getVulnerabilityScan(req.orgId!, scan.id), matches: result.matches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan failed";
    await store().finishVulnerabilityScan(req.orgId!, scan.id, { status: "failed", componentsSeen: 0, matchesFound: 0, truncated: false, error: message });
    res.status(502).json({ error: message });
  }
});

vulnerabilitiesRouter.get("/scans", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  res.json({ scans: await store().listVulnerabilityScans(req.orgId!) });
});

vulnerabilitiesRouter.get("/scans/:id", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  const scan = await store().getVulnerabilityScan(req.orgId!, String(req.params.id));
  if (!scan) { res.status(404).json({ error: "Scan not found" }); return; }
  res.json({ scan });
});

vulnerabilitiesRouter.get("/findings", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  res.json({
    findings: await store().listVulnerabilityMatches(req.orgId!, {
      repo: typeof req.query.repo === "string" ? req.query.repo : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
    }),
  });
});

vulnerabilitiesRouter.patch("/findings/:id", requirePermission("vulnerabilities:manage"), async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as { status?: unknown; reason?: unknown };
  const status = body.status === "dismissed" ? "dismissed" : body.status === "open" ? "open" : null;
  if (!status) { res.status(400).json({ error: "status must be open or dismissed" }); return; }
  const ok = await store().setVulnerabilityMatchStatus(req.orgId!, String(req.params.id), status, typeof body.reason === "string" ? body.reason.slice(0, 400) : undefined);
  if (!ok) { res.status(404).json({ error: "Finding not found" }); return; }
  res.json({ ok: true });
});

vulnerabilitiesRouter.get("/watches", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  res.json({ watches: await store().listVulnerabilityWatches(req.orgId!) });
});

vulnerabilitiesRouter.post("/watches", requirePermission("vulnerabilities:manage"), async (req: AuthedRequest, res) => {
  const repo = typeof (req.body as { repo?: unknown })?.repo === "string" ? String((req.body as { repo: string }).repo).trim().slice(0, 200) : "";
  if (!repo) { res.status(400).json({ error: "repo is required" }); return; }
  res.status(201).json(await store().upsertVulnerabilityWatch({ orgId: req.orgId!, userId: req.userId!, repo }));
});

vulnerabilitiesRouter.delete("/watches/:id", requirePermission("vulnerabilities:manage"), async (req: AuthedRequest, res) => {
  const ok = await store().deleteVulnerabilityWatch(req.orgId!, String(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

/** Catalog detail LAST — the param route must not shadow the fixed paths above. */
vulnerabilitiesRouter.get("/:cveId", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  const cveId = String(req.params.cveId).toUpperCase();
  const vulnerability = await store().getVulnerability(cveId);
  if (!vulnerability) { res.status(404).json({ error: "CVE not found in the catalog" }); return; }
  res.json(vulnerability);
});
