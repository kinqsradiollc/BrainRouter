/**
 * GitHub repo linking (ADR-014 Phase E) — list the repositories the Team's own
 * GitHub App installation can access, so an admin can LINK a repo to a project /
 * the memory system. Reuses the org's `github_app` integration + core's
 * installation-token minter (short-lived per-installation tokens, no broad PAT).
 * Mounted at /api/orgs (alongside orgsRouter/projectsRouter). RBAC: triggers:manage.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { can } from "../../../tenancy/rbac.js";
import { mintInstallationToken } from "@kinqs/brainrouter-core/track";

export const githubReposRouter = Router();
githubReposRouter.use(requireAnyAuth);

const DEFAULT_API_BASE = "https://api.github.com";

/** Resolve the caller's role for :orgId and require triggers:manage. */
async function requireTriggersManage(req: AuthedRequest, res: import("express").Response): Promise<boolean> {
  const orgId = String(req.params.orgId ?? "").trim();
  if (!orgId) { sendError(res, 400, "orgId is required"); return false; }
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!can(role, "triggers:manage")) {
    sendError(res, 403, "This action requires the 'triggers:manage' capability");
    return false;
  }
  return true;
}

/** GET /api/orgs/:orgId/github/status — is the Team's GitHub App configured + installed? */
githubReposRouter.get("/:orgId/github/status", async (req: AuthedRequest, res) => {
  if (!(await requireTriggersManage(req, res))) return;
  const orgId = String(req.params.orgId);
  const integ = await memoryEngine.integrations.getResolvedIntegration(orgId, "github_app");
  const appSlug = integ ? String(integ.config.appSlug ?? "").trim() : "";
  res.json({
    configured: !!integ,
    installed: !!(integ && String(integ.config.installationId ?? "").trim()),
    // Where the admin installs the App on their org + grants repo access.
    installUrl: appSlug ? `https://github.com/apps/${appSlug}/installations/new` : undefined,
  });
});

/**
 * GET /api/orgs/:orgId/github/repos — the repositories the Team's GitHub App
 * installation can see (i.e. the repos the org granted the App). Mints a fresh
 * installation token and calls GET /installation/repositories.
 */
githubReposRouter.get("/:orgId/github/repos", async (req: AuthedRequest, res) => {
  if (!(await requireTriggersManage(req, res))) return;
  const orgId = String(req.params.orgId);
  const integ = await memoryEngine.integrations.getResolvedIntegration(orgId, "github_app");
  if (!integ) { res.json({ configured: false, installed: false, repos: [] }); return; }

  const appId = String(integ.config.appId ?? "").trim();
  const installationId = String(integ.config.installationId ?? "").trim();
  const privateKey = String(integ.secret.privateKey ?? "").trim();
  const apiBase = String(integ.config.apiBase ?? DEFAULT_API_BASE).trim() || DEFAULT_API_BASE;
  if (!appId || !privateKey || !installationId) { res.json({ configured: true, installed: false, repos: [] }); return; }

  try {
    const deps = { fetchImpl: fetch as unknown as typeof fetch, nowSec: () => Math.floor(Date.now() / 1000) };
    const tok = await mintInstallationToken({ appId, privateKey, apiBase }, installationId, deps);
    const r = await fetch(`${apiBase}/installation/repositories?per_page=100`, {
      headers: { Authorization: `Bearer ${tok.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      res.json({ configured: true, installed: true, repos: [], error: `GitHub ${r.status}: ${body.slice(0, 200)}` });
      return;
    }
    const data = (await r.json()) as { repositories?: Array<{ full_name?: string; html_url?: string; private?: boolean; default_branch?: string }> };
    const repos = (Array.isArray(data.repositories) ? data.repositories : [])
      .map((x) => ({ fullName: String(x.full_name ?? ""), url: String(x.html_url ?? ""), private: !!x.private, defaultBranch: String(x.default_branch ?? "main") }))
      .filter((x) => x.fullName);
    res.json({ configured: true, installed: true, repos });
  } catch (error) {
    res.json({ configured: true, installed: false, repos: [], error: error instanceof Error ? error.message : "Failed to list repositories" });
  }
});
