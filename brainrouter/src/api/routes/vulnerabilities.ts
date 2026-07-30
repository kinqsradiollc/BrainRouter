/**
 * CVE intelligence API (spec §10.3, Task 31). Catalog reads are global data
 * behind vulnerabilities:read; scans/findings/watches are org-scoped; source
 * refresh is vulnerabilities:manage. A scan accepts the repository's OWN
 * lockfile/manifest/SBOM contents — exposure always carries exact evidence.
 */
import { Router } from "express";
import { z } from "zod";
import { mintInstallationToken, validateGithubApiBase } from "@kinqs/brainrouter-core/track";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { requirePermission } from "../middleware/tenancy.js";
import { memoryEngine } from "../../memory/engine.js";
import { parseInventoryFile, SUPPORTED_INVENTORY_FILES } from "../../vulnerability/inventory.js";
import type { InventoryComponent } from "../../vulnerability/types.js";
import { enqueueAgentJob } from "../../memory/scheduler/jobs.js";
import { resolveGithubAccountToken } from "../../connectors/githubAccountToken.js";
import { canAccessGithubRepository } from "../../integrations/githubWebhook.js";
import { getCache, cacheKeyFromFilters } from "../../infra/cache.js";

type CatalogStore = {
  listVulnerabilities(filters: Record<string, unknown>): Promise<{ items: unknown[]; total: number }>;
  getVulnerability(cveId: string): Promise<unknown | null>;
  listVulnerabilitySources(): Promise<unknown[]>;
  listActiveVulnerabilityFeedRuns?(): Promise<Array<{ id: string; sourceId: string; startedAt: string; itemsSeen: number; itemsUpserted: number }>>;
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

const repoSchema = z.string().trim().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const vulnerabilityScanRequestSchema = z.object({
  repo: repoSchema,
  files: z.array(z.object({ path: z.string().trim().min(1).max(500), content: z.string().max(8 * 1024 * 1024) })).min(1).max(20),
});

function projectRepo(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  const value = repoUrl.trim().replace(/\.git$/i, "");
  const match = value.match(/(?:github\.com[/:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i) ?? value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Current access, independent of the automatic-review allowlist. */
export async function canAccessVulnerabilityRepository(input: {
  orgId: string;
  userId: string;
  repo: string;
  isOrgAdmin: boolean;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const normalized = input.repo.toLowerCase();
  const projects = await memoryEngine.projects.listAccessibleProjects(input.orgId, input.userId, input.isOrgAdmin).catch(() => []);
  if (projects.some((project) => projectRepo(project.repoUrl) === normalized)) return true;

  const account = await resolveGithubAccountToken(memoryEngine.emailAuth, input.userId).catch(() => null);
  if (account && await canAccessGithubRepository(input.repo, { apiBase: "https://api.github.com", token: account.accessToken }, fetchImpl)) return true;

  try {
    const integration = await memoryEngine.integrations.getResolvedIntegration(input.orgId, "github_app");
    const appId = String(integration?.config.appId ?? "").trim();
    const installationId = String(integration?.config.installationId ?? "").trim();
    const privateKey = String(integration?.secret.privateKey ?? "").trim();
    if (!appId || !installationId || !privateKey) return false;
    const apiBase = validateGithubApiBase(typeof integration?.config.apiBase === "string" ? integration.config.apiBase : "") ?? "https://api.github.com";
    const token = await mintInstallationToken({ appId, privateKey, apiBase }, installationId, { fetchImpl: fetchImpl as never, nowSec: () => Math.floor(Date.now() / 1000) });
    return canAccessGithubRepository(input.repo, { apiBase, token: token.token }, fetchImpl);
  } catch {
    return false;
  }
}

function isOrgAdmin(req: AuthedRequest): boolean {
  return Boolean(req.isAdmin || req.role === "owner" || req.role === "admin");
}

export const vulnerabilitiesRouter = Router();
vulnerabilitiesRouter.use(requireAnyAuth);

/** Catalog list — server-paginated; filters mirror the dashboard's URL params. */
vulnerabilitiesRouter.get("/", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  const q = req.query;
  const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const filters = {
    search: typeof q.search === "string" ? q.search.slice(0, 200) : undefined,
    severity: typeof q.severity === "string" ? q.severity : undefined,
    kevOnly: q.kev === "true",
    minCvss: num(q.minCvss),
    minEpss: num(q.minEpss),
    ecosystem: typeof q.ecosystem === "string" ? q.ecosystem : undefined,
    modifiedSince: typeof q.modifiedSince === "string" ? q.modifiedSince : undefined,
    limit: num(q.limit),
    offset: num(q.offset),
  };
  // Catalog is GLOBAL and only changes on the scheduled sync (≥15 min), so a
  // short-TTL cache keyed by the exact filters absorbs the dashboard's repeated
  // reads without going stale in any meaningful way.
  const key = cacheKeyFromFilters("vuln:list", filters as Record<string, unknown>);
  const result = await getCache().wrap(key, 60, () => store().listVulnerabilities(filters));
  res.json(result);
});

vulnerabilitiesRouter.get("/sources", requirePermission("vulnerabilities:read"), async (_req: AuthedRequest, res) => {
  const catalog = store();
  const [sources, runs] = await Promise.all([
    catalog.listVulnerabilitySources(),
    catalog.listActiveVulnerabilityFeedRuns?.() ?? Promise.resolve([]),
  ]);
  const activeBySource = new Map(runs.map((run) => [run.sourceId, run]));
  res.json({
    sources: sources.map((source) => {
      const row = source as { id?: unknown };
      return { ...(source as Record<string, unknown>), activeRun: activeBySource.get(String(row.id)) ?? null };
    }),
  });
});

/** Manual source refresh (manage) — background job with durable progress/retry. */
vulnerabilitiesRouter.post("/sources/:id/refresh", requirePermission("vulnerabilities:manage"), async (req: AuthedRequest, res) => {
  const id = String(req.params.id);
  if (!new Set(["nvd", "cisa-kev", "first-epss"]).has(id)) {
    res.status(404).json({ error: `Unknown source "${id}"` });
    return;
  }
  try {
    const queued = await enqueueAgentJob(memoryEngine.store, "vulnerability_sync", {
      mode: "manual", sourceId: id, orgId: req.orgId!, requestedBy: req.userId!,
    }, { priority: 100 });
    res.status(202).json({ sourceId: id, job: { id: queued.job.id, status: queued.job.status, deduped: queued.deduped } });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Source refresh could not be queued" });
  }
});

/** Manual repository scan: authorize + persist exact inventory, then queue OSV. */
vulnerabilitiesRouter.post("/scans", requirePermission("vulnerabilities:scan"), async (req: AuthedRequest, res) => {
  const parsed = vulnerabilityScanRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: `repo and valid files are required (supported: ${SUPPORTED_INVENTORY_FILES.join(", ")})`, details: parsed.error.issues.map((issue) => issue.message) });
    return;
  }
  const { repo, files } = parsed.data;
  const accessible = await canAccessVulnerabilityRepository({ orgId: req.orgId!, userId: req.userId!, repo, isOrgAdmin: isOrgAdmin(req) });
  if (!accessible) {
    res.status(403).json({ error: "Repository is not available through your current project or connected GitHub authorization" });
    return;
  }
  const components: InventoryComponent[] = [];
  for (const file of files) components.push(...parseInventoryFile(file.path, file.content));
  const dedupedComponents = [...new Map(components.map((component) => [`${component.purl}\n${component.evidence}`, component])).values()];
  if (dedupedComponents.length === 0) {
    res.status(422).json({ error: `No exact component versions were found (supported: ${SUPPORTED_INVENTORY_FILES.join(", ")})` });
    return;
  }
  const scan = await store().createVulnerabilityScan({ orgId: req.orgId!, userId: req.userId!, repo });
  try {
    await store().replaceAssetComponents(req.orgId!, repo, scan.id, dedupedComponents);
    const queued = await enqueueAgentJob(memoryEngine.store, "vulnerability_scan", { orgId: req.orgId!, userId: req.userId!, repo, scanId: scan.id }, { priority: 90 });
    res.status(202).json({ scan: await store().getVulnerabilityScan(req.orgId!, scan.id), job: { id: queued.job.id, status: queued.job.status, deduped: queued.deduped }, componentsSeen: dedupedComponents.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scan could not be queued";
    await store().finishVulnerabilityScan(req.orgId!, scan.id, { status: "failed", componentsSeen: dedupedComponents.length, matchesFound: 0, truncated: false, error: message });
    res.status(503).json({ error: message, scanId: scan.id });
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
  if (!repoSchema.safeParse(repo).success || !(await canAccessVulnerabilityRepository({ orgId: req.orgId!, userId: req.userId!, repo, isOrgAdmin: isOrgAdmin(req) }))) {
    res.status(403).json({ error: "Repository is not available through your current project or connected GitHub authorization" });
    return;
  }
  res.status(201).json(await store().upsertVulnerabilityWatch({ orgId: req.orgId!, userId: req.userId!, repo }));
});

vulnerabilitiesRouter.delete("/watches/:id", requirePermission("vulnerabilities:manage"), async (req: AuthedRequest, res) => {
  const ok = await store().deleteVulnerabilityWatch(req.orgId!, String(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

/** Catalog detail LAST — the param route must not shadow the fixed paths above. */
vulnerabilitiesRouter.get("/:cveId", requirePermission("vulnerabilities:read"), async (req: AuthedRequest, res) => {
  const cveId = String(req.params.cveId).toUpperCase();
  // Cache HITS only (5 min) — a missing CVE recomputes so a newly-synced entry
  // appears immediately rather than being negative-cached.
  const cache = getCache();
  const cacheKey = `vuln:cve:${cveId}`;
  let vulnerability = await cache.get<unknown>(cacheKey);
  if (vulnerability === undefined) {
    vulnerability = await store().getVulnerability(cveId);
    if (vulnerability) await cache.set(cacheKey, vulnerability, 300);
  }
  if (!vulnerability) { res.status(404).json({ error: "CVE not found in the catalog" }); return; }
  res.json(vulnerability);
});
