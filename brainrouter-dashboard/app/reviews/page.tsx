"use client";

/**
 * Reviews — the dashboard surface for the GitHub App's automatic PR reviewer
 * (ADR-017 D5). Two lenses run on every reviewed PR (SECURITY + CODE-REVIEW), each
 * posting inline ```suggestion comments and a gating check-run. This page controls
 * WHICH repos are auto-reviewed: the toggle writes the org's `github_app` integration
 * `config.linkedRepositories` allowlist that the webhook gates on (`isRepoLinkedForReview`).
 * Org owner/admin only (backend enforces triggers:manage per org).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type OrgSummary, type IntegrationConfig, type ReviewJob } from "../../lib/adminApi";

interface Repo { fullName: string; url: string; private: boolean; defaultBranch: string }

function ReviewsInner() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [integ, setInteg] = useState<IntegrationConfig | null>(null);
  const [reviews, setReviews] = useState<ReviewJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await adminApi.listOrgs();
        setOrgs(res.orgs ?? []);
        const wanted = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("org") : null;
        const pick = (wanted && res.orgs?.find((o) => o.orgId === wanted)) ?? res.orgs?.find((o) => o.isDefault) ?? res.orgs?.[0];
        if (pick) setActiveOrg(pick.orgId);
      } catch (e) { setError(e instanceof Error ? e.message : "Failed to load organizations"); }
    })();
  }, []);

  const load = useCallback(async (orgId: string) => {
    if (!orgId) return;
    setLoading(true); setError("");
    try {
      const [rp, ig, rv] = await Promise.all([
        adminApi.githubRepos(orgId).catch(() => ({ repos: [] as Repo[] })),
        adminApi.listIntegrations(orgId).catch(() => ({ integrations: [] as IntegrationConfig[] })),
        adminApi.listReviewJobs(orgId, 30).catch(() => ({ reviews: [] as ReviewJob[] })),
      ]);
      setRepos(((rp as { repos?: Repo[] }).repos) ?? []);
      setInteg((ig.integrations ?? []).find((i) => i.kind === "github_app") ?? null);
      setReviews(rv.reviews ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(activeOrg); }, [activeOrg, load]);

  // null → allowlist absent → ALL accessible repos are reviewed (opt-out default).
  const linked = useMemo(() => {
    const raw = integ?.config?.linkedRepositories;
    return Array.isArray(raw) ? (raw as string[]) : null;
  }, [integ]);
  const isAuto = (full: string) => linked === null || linked.includes(full);
  const autoCount = repos.filter((r) => isAuto(r.fullName)).length;

  async function toggle(repo: Repo, on: boolean) {
    if (!integ) { setError("Configure the GitHub App first on the Integrations page."); return; }
    setBusy(repo.fullName);
    try {
      // From all-on (null) the first toggle-off MATERIALIZES the full list minus this
      // repo; thereafter it's plain add/remove on an explicit allowlist.
      const base = linked ?? repos.map((r) => r.fullName);
      const next = on ? Array.from(new Set([...base, repo.fullName])) : base.filter((f) => f !== repo.fullName);
      await adminApi.updateIntegration(integ.id, { config: { ...integ.config, linkedRepositories: next } }, activeOrg);
      await load(activeOrg);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to update"); }
    finally { setBusy(""); }
  }

  const shown = search.trim() ? repos.filter((r) => r.fullName.toLowerCase().includes(search.trim().toLowerCase())) : repos;

  return (
    <div className="settings-page">
      <PageHeader title="Reviews" description="Automatic AI review of every pull request — a security pass and a general code-review pass — with inline suggestions and gating checks. Choose which repos are reviewed." />
      <div className="settings-hint" style={{ marginTop: "calc(-1 * var(--spacing-8))" }}>
        <Link href="/integrations" className="settings-link">Configure the GitHub App →</Link>
      </div>

      {orgs.length > 1 && (
        <label className="settings-label" style={{ maxWidth: "22rem", marginTop: "var(--spacing-16)" }}>Team
          <select className="settings-select" value={activeOrg} onChange={(e) => setActiveOrg(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
      )}
      {error && <div className="settings-note settings-note--error">{error}</div>}

      {/* What the bot does — the effective, shipped behavior. */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <div className="settings-cardhead"><div><h3>How reviews work</h3><div className="settings-hint">Two lenses run on every reviewed PR; each posts inline suggestions + a gating check-run. Re-run any time with a <code>/review</code> PR comment.</div></div></div>
        <div className="settings-item"><span className="settings-row__title">🛡️ Security review — vulnerability findings</span><span className="settings-flag-ok">on</span></div>
        <div className="settings-item"><span className="settings-row__title">🔎 Code review — correctness · clarity · perf · tests</span><span className="settings-flag-ok">on</span></div>
        <div className="settings-item"><span className="settings-row__title">Block the merge on critical/high findings</span><span className="settings-flag-ok">on</span></div>
        <div className="settings-item"><span className="settings-row__title">Re-review on every push</span><span className="settings-flag-ok">on</span></div>
      </PremiumCard>

      {/* Recent reviews — read from the review jobs the bot has run. */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}>
        <div className="settings-cardhead">
          <div><h3>Recent reviews</h3><div className="settings-hint">The latest pull-request reviews the bot has run (both lenses).</div></div>
          <span className="settings-badge settings-badge--muted">{reviews.length}</span>
        </div>
        {loading ? (
          <div className="settings-empty-inline">Loading…</div>
        ) : reviews.length === 0 ? (
          <div className="settings-empty-inline">No reviews yet — open or push a PR on an auto-reviewed repo.</div>
        ) : (
          <div>
            {reviews.map((r) => (
              <div key={r.id} className="settings-item">
                <div className="min-w-0">
                  <span className="settings-row__title truncate">{r.lens === "security" ? "🛡️" : "🔎"} {r.repo ?? "—"}{r.prNumber ? ` #${r.prNumber}` : ""}</span>
                  <div className="settings-row__sub truncate">
                    {r.error ? `error: ${r.error}` : r.skipped ? `skipped: ${r.skipped}` : r.findings !== null ? `${r.findings} finding(s)${r.blocking ? ` · ${r.blocking} blocking` : ""}` : r.status}
                  </div>
                </div>
                <span className={r.status === "done" ? (r.blocking ? "settings-flag-muted" : "settings-flag-ok") : "settings-badge settings-badge--muted"}>{r.status}</span>
              </div>
            ))}
          </div>
        )}
      </PremiumCard>

      {/* Per-repo auto-review — writes the linkedRepositories allowlist. */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}>
        <div className="settings-cardhead">
          <div>
            <h3>Auto-review repositories</h3>
            <div className="settings-hint">{linked === null ? "All accessible repos are reviewed. Turn one off to review only a chosen set." : `${autoCount} of ${repos.length} repositories reviewed.`}</div>
          </div>
          <span className="settings-badge settings-badge--muted">{autoCount} on</span>
        </div>
        <input className="settings-input" placeholder="Search repositories…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ margin: "8px 0" }} />
        {loading ? (
          <div className="settings-empty-inline">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="settings-empty-inline">{repos.length === 0 ? "No repositories — install the GitHub App and grant it repo access on the Integrations page." : `No repositories match “${search}”.`}</div>
        ) : (
          <div>
            {shown.map((r) => {
              const on = isAuto(r.fullName);
              return (
                <div key={r.fullName} className="settings-item">
                  <div className="min-w-0">
                    <span className="settings-row__title truncate" title={r.fullName}>{r.fullName}</span>
                    {r.private && <span className="settings-badge settings-badge--muted" style={{ marginLeft: 6 }}>private</span>}
                  </div>
                  <PremiumButton size="small" variant={on ? "ghost" : "primary"} disabled={busy === r.fullName} onClick={() => toggle(r, !on)}>
                    {busy === r.fullName ? "…" : on ? "Auto-review: On" : "Auto-review: Off"}
                  </PremiumButton>
                </div>
              );
            })}
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

export default function ReviewsPage() {
  return (
    <AuthGuard>
      <ReviewsInner />
    </AuthGuard>
  );
}
