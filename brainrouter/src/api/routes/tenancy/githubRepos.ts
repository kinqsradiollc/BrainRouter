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
import { mintInstallationToken, buildAppJwt } from "@kinqs/brainrouter-core/track";

export const githubReposRouter = Router();
githubReposRouter.use(requireAnyAuth);

const DEFAULT_API_BASE = "https://api.github.com";

/**
 * Auto-resolve the installation id from the App itself: list the App's
 * installations (App JWT) and take the first. For an App installed "only on this
 * account" there is exactly one, so an admin never has to hand-copy an id — they
 * just install on GitHub and we discover it. Returns "" on none/any error.
 */
async function autoResolveInstallationId(appId: string, privateKey: string, apiBase: string): Promise<string> {
  try {
    const jwt = buildAppJwt({ appId, privateKey }, Math.floor(Date.now() / 1000));
    const r = await fetch(`${apiBase}/app/installations?per_page=100`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) return "";
    const data = (await r.json()) as Array<{ id?: number | string }>;
    return Array.isArray(data) && data.length ? String(data[0]?.id ?? "") : "";
  } catch {
    return "";
  }
}

/** Resolve the caller's role for :orgId and require triggers:manage. */
async function requireTriggersManage(req: AuthedRequest, res: import("express").Response): Promise<boolean> {
  const orgId = String(req.params.orgId ?? "").trim();
  if (!orgId) { sendError(res, 400, "orgId is required"); return false; }
  // Global admins have full access to the admin surfaces (providers / integrations
  // / triggers) regardless of their per-org member role — parity with the shared
  // requirePermission() middleware. Without this a global admin whose personal-org
  // role is "viewer" gets a 403 the UI silently swallows as "not configured".
  if (req.isAdmin) return true;
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
  let installed = false;
  if (integ) {
    const explicitId = String(integ.config.installationId ?? "").trim();
    if (explicitId) {
      installed = true;
    } else {
      // No id stored — probe the App for a live installation so the dashboard
      // flips to "installed" the moment the admin grants access on GitHub.
      const appId = String(integ.config.appId ?? "").trim();
      const privateKey = String(integ.secret.privateKey ?? "").trim();
      const apiBase = String(integ.config.apiBase ?? DEFAULT_API_BASE).trim() || DEFAULT_API_BASE;
      if (appId && privateKey) installed = !!(await autoResolveInstallationId(appId, privateKey, apiBase));
    }
  }
  res.json({
    configured: !!integ,
    installed,
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
  let installationId = String(integ.config.installationId ?? "").trim();
  const privateKey = String(integ.secret.privateKey ?? "").trim();
  const apiBase = String(integ.config.apiBase ?? DEFAULT_API_BASE).trim() || DEFAULT_API_BASE;
  if (!appId || !privateKey) { res.json({ configured: true, installed: false, repos: [] }); return; }
  // Installation id is optional in config — discover it from the App if absent.
  if (!installationId) installationId = await autoResolveInstallationId(appId, privateKey, apiBase);
  if (!installationId) { res.json({ configured: true, installed: false, repos: [] }); return; }

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
