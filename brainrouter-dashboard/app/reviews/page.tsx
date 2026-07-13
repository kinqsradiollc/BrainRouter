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

const POLICY_DEFAULTS = { approveClean: false, blockOnFindings: true, reReviewOnPush: true } as const;
type PolicyField = keyof typeof POLICY_DEFAULTS;
const POLICY_META: { f: PolicyField; label: string; hint: string }[] = [
  { f: "approveClean", label: "Approve clean PRs", hint: "Post an approving review when a lens finds nothing." },
  { f: "blockOnFindings", label: "Block on findings", hint: "A critical/high finding fails the check-run (gates merge)." },
  { f: "reReviewOnPush", label: "Re-review on push", hint: "Re-run both lenses on every new commit." },
];

/** A compact segmented control; the active option is filled. */
function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", gap: 2, background: "var(--surface-2, rgba(255,255,255,0.04))", borderRadius: 6, padding: 2 }}>
      {options.map((o) => (
        <button key={o.v} type="button" disabled={disabled} onClick={() => onChange(o.v)}
          style={{
            cursor: disabled ? "default" : "pointer", border: 0, padding: "3px 10px", borderRadius: 4, fontSize: 12,
            background: value === o.v ? "var(--surface-4, rgba(255,255,255,0.12))" : "transparent",
            color: value === o.v ? "var(--text, #fff)" : "var(--text-muted, #999)", fontWeight: value === o.v ? 600 : 400,
          }}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

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

  // ── Per-repo review policy (Strix Approve / Block / Re-review) ────────────────
  const cfgDefaults = (integ?.config?.reviewPolicyDefaults ?? {}) as Partial<Record<PolicyField, boolean>>;
  const cfgRepo = (integ?.config?.reviewPolicies ?? {}) as Record<string, Partial<Record<PolicyField, boolean>>>;
  const orgDefault = (f: PolicyField): boolean => cfgDefaults[f] ?? POLICY_DEFAULTS[f];
  const repoOverride = (repo: string, f: PolicyField): boolean | undefined => cfgRepo[repo]?.[f];
  // Every config write (auto-review toggle AND policy) is computed from the render-time
  // integ.config snapshot, so any two overlapping writes would each merge into the same
  // stale snapshot and the later one would clobber the earlier (lost update). `busy` is
  // set at the start of EVERY write and cleared in its finally, so gating all config
  // controls on `busy !== ""` serialises writes to one at a time — load() refetches
  // between them — which removes the race entirely.
  const configBusy = busy !== "";

  async function patchConfig(next: Record<string, unknown>, key: string) {
    if (!integ) { setError("Configure the GitHub App first on the Integrations page."); return; }
    setBusy(key);
    try { await adminApi.updateIntegration(integ.id, { config: { ...integ.config, ...next } }, activeOrg); await load(activeOrg); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to update"); }
    finally { setBusy(""); }
  }
  const setDefault = (f: PolicyField, v: boolean) => patchConfig({ reviewPolicyDefaults: { ...cfgDefaults, [f]: v } }, `def:${f}`);
  const setRepoPolicy = (repo: string, f: PolicyField, v: boolean | undefined) => {
    const cur = { ...(cfgRepo[repo] ?? {}) };
    if (v === undefined) delete cur[f]; else cur[f] = v;
    const nextRepos = { ...cfgRepo };
    if (Object.keys(cur).length === 0) delete nextRepos[repo]; else nextRepos[repo] = cur;
    return patchConfig({ reviewPolicies: nextRepos }, `repo:${repo}:${f}`);
  };

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
        <div className="settings-item"><span className="settings-row__title">🛡️ Security review — vulnerability findings</span><span className="settings-flag-ok">gates the merge</span></div>
        <div className="settings-item"><span className="settings-row__title">🔎 Code review — correctness · clarity · perf · tests</span><span className="settings-badge settings-badge--muted">advisory</span></div>
      </PremiumCard>

      {/* Policy defaults — org-wide; per-repo overrides live in the repo list below. */}
      <PremiumCard level={2} style={{ marginTop: "var(--spacing-20)" }}>
        <div className="settings-cardhead"><div><h3>Policy defaults</h3><div className="settings-hint">Applied to every reviewed repo unless a repo overrides it below.</div></div></div>
        {POLICY_META.map(({ f, label, hint }) => (
          <div key={f} className="settings-item">
            <div className="min-w-0"><span className="settings-row__title">{label}</span><div className="settings-row__sub">{hint}</div></div>
            <Segmented value={orgDefault(f) ? "on" : "off"} disabled={configBusy}
              options={[{ v: "on", label: "On" }, { v: "off", label: "Off" }]}
              onChange={(v) => setDefault(f, v === "on")} />
          </div>
        ))}
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
                <div key={r.fullName} style={{ padding: "8px 0", borderBottom: "1px solid var(--border-dim, rgba(255,255,255,0.06))" }}>
                  <div className="settings-item" style={{ borderBottom: 0, padding: 0 }}>
                    <div className="min-w-0">
                      <span className="settings-row__title truncate" title={r.fullName}>{r.fullName}</span>
                      {r.private && <span className="settings-badge settings-badge--muted" style={{ marginLeft: 6 }}>private</span>}
                    </div>
                    <PremiumButton size="small" variant={on ? "ghost" : "primary"} disabled={configBusy} onClick={() => toggle(r, !on)}>
                      {busy === r.fullName ? "…" : on ? "Auto-review: On" : "Auto-review: Off"}
                    </PremiumButton>
                  </div>
                  {on && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8, paddingLeft: 2 }}>
                      {POLICY_META.map(({ f, label }) => {
                        const ov = repoOverride(r.fullName, f);
                        const cur = ov === undefined ? "default" : ov ? "on" : "off";
                        return (
                          <span key={f} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span className="settings-row__sub">{label}</span>
                            <Segmented value={cur} disabled={configBusy}
                              options={[{ v: "default", label: `Default (${orgDefault(f) ? "On" : "Off"})` }, { v: "on", label: "On" }, { v: "off", label: "Off" }]}
                              onChange={(v) => setRepoPolicy(r.fullName, f, v === "default" ? undefined : v === "on")} />
                          </span>
                        );
                      })}
                    </div>
                  )}
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
