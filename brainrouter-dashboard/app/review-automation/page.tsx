"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { useAuth } from "../../components/AuthProvider";
import { PageHeader } from "../../components/PageHeader";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumCard } from "../../components/PremiumCard";
import { adminApi, type IntegrationConfig, type OrgSummary } from "../../lib/adminApi";

interface Repo {
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
}

const POLICY_DEFAULTS = { approveClean: false, blockOnFindings: true, reReviewOnPush: true } as const;
type PolicyField = keyof typeof POLICY_DEFAULTS;
type ReviewPolicyDefaults = Partial<Record<PolicyField, boolean>> & {
  codeReviewTrigger?: "auto" | "manual";
  developersCanRun?: boolean;
};
type RepositoryPolicy = Partial<Record<PolicyField, boolean>> & { codeReviewTrigger?: "auto" | "manual" };
type ManualReviewRunners = { minPermission?: "admin" | "maintain" | "write"; allowlist?: string[] };

const POLICY_META: Array<{ field: PolicyField; label: string; hint: string }> = [
  { field: "approveClean", label: "Approve clean PRs", hint: "Post an approving review when a lens finds nothing." },
  { field: "blockOnFindings", label: "Block on findings", hint: "Critical or high security findings fail the check run." },
  { field: "reReviewOnPush", label: "Re-review on push", hint: "Run enabled automatic lenses again after a new commit." },
];

function initialOrg(): string {
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("org") ?? "";
}

function Segmented<T extends string>({ value, options, onChange, disabled, label }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="review-automation__segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" disabled={disabled} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </span>
  );
}

function ReviewAutomationInner() {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrg, setActiveOrg] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [integration, setIntegration] = useState<IntegrationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [runnerAllowlist, setRunnerAllowlist] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await adminApi.listOrgs();
        const available = response.orgs ?? [];
        setOrgs(available);
        const requested = initialOrg();
        const selected = available.find((org) => org.orgId === requested)
          ?? available.find((org) => org.isDefault)
          ?? available[0];
        if (selected) setActiveOrg(selected.orgId);
        else setLoading(false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to load organizations");
        setLoading(false);
      }
    })();
  }, []);

  const activeOrgRecord = orgs.find((org) => org.orgId === activeOrg);
  const canManage = Boolean(
    user?.isAdmin
    || activeOrgRecord?.capabilities.includes("triggers:manage")
    || activeOrgRecord?.role === "owner"
    || activeOrgRecord?.role === "admin",
  );

  const load = useCallback(async (orgId: string, allowed: boolean) => {
    if (!orgId) return;
    setLoading(true);
    setError("");
    if (!allowed) {
      setRepos([]);
      setIntegration(null);
      setLoading(false);
      return;
    }
    try {
      const [repositoryResponse, integrationResponse] = await Promise.all([
        adminApi.githubRepos(orgId),
        adminApi.listIntegrations(orgId),
      ]);
      setRepos(repositoryResponse.repos ?? []);
      const github = (integrationResponse.integrations ?? []).find((item) => item.kind === "github_app") ?? null;
      setIntegration(github);
      const runners = (github?.config.manualReviewRunners ?? {}) as ManualReviewRunners;
      setRunnerAllowlist((runners.allowlist ?? []).join(", "));
      if (repositoryResponse.error) setError(repositoryResponse.error);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load review automation");
      setRepos([]);
      setIntegration(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(activeOrg, canManage); }, [activeOrg, canManage, load]);

  const linked = useMemo(() => {
    const configured = integration?.config.linkedRepositories;
    return Array.isArray(configured) ? configured.filter((value): value is string => typeof value === "string") : null;
  }, [integration]);
  const isAutomatic = (repo: string) => linked === null || linked.includes(repo);
  const automaticCount = repos.filter((repo) => isAutomatic(repo.fullName)).length;
  const defaults = (integration?.config.reviewPolicyDefaults ?? {}) as ReviewPolicyDefaults;
  const policies = (integration?.config.reviewPolicies ?? {}) as Record<string, RepositoryPolicy>;
  const runners = (integration?.config.manualReviewRunners ?? {}) as ManualReviewRunners;
  const configBusy = busy !== "";

  const patchConfig = async (next: Record<string, unknown>, key: string) => {
    if (!integration) {
      setError("Configure the organization GitHub App before changing review automation.");
      return;
    }
    setBusy(key);
    setError("");
    try {
      await adminApi.updateIntegration(integration.id, { config: { ...integration.config, ...next } }, activeOrg);
      await load(activeOrg, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update review automation");
    } finally {
      setBusy("");
    }
  };

  const setAutomatic = async (repo: Repo, on: boolean) => {
    const base = linked ?? repos.map((item) => item.fullName);
    const next = on ? [...new Set([...base, repo.fullName])] : base.filter((value) => value !== repo.fullName);
    await patchConfig({ linkedRepositories: next }, `repo:${repo.fullName}:automatic`);
  };

  const setDefault = (field: PolicyField, value: boolean) => patchConfig({ reviewPolicyDefaults: { ...defaults, [field]: value } }, `default:${field}`);

  const setRepositoryPolicy = (repo: string, field: PolicyField, value: boolean | undefined) => {
    const nextPolicy = { ...(policies[repo] ?? {}) };
    if (value === undefined) delete nextPolicy[field];
    else nextPolicy[field] = value;
    const nextPolicies = { ...policies };
    if (Object.keys(nextPolicy).length === 0) delete nextPolicies[repo];
    else nextPolicies[repo] = nextPolicy;
    return patchConfig({ reviewPolicies: nextPolicies }, `repo:${repo}:${field}`);
  };

  const setCodeTrigger = (repo: string | null, value: "auto" | "manual") => {
    if (!repo) return patchConfig({ reviewPolicyDefaults: { ...defaults, codeReviewTrigger: value } }, "default:code-trigger");
    return patchConfig({ reviewPolicies: { ...policies, [repo]: { ...(policies[repo] ?? {}), codeReviewTrigger: value } } }, `repo:${repo}:code-trigger`);
  };

  const setManualRunners = (permission: "admin" | "maintain" | "write", value: string) => patchConfig({
    manualReviewRunners: {
      minPermission: permission,
      allowlist: value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean),
    },
  }, "manual-runners");

  const shown = repos.filter((repo) => repo.fullName.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="settings-page review-automation">
      <PageHeader title="Review automation" description="Organization defaults, automatic enrollment, and repository-specific review policy.">
        <Link className="premium-button premium-button--ghost premium-button--medium" href={`/reviews${activeOrg ? `?org=${encodeURIComponent(activeOrg)}` : ""}`}>Open PR reviews</Link>
      </PageHeader>

      {orgs.length > 1 && (
        <label className="settings-label review-automation__org">Team
          <select className="settings-select" value={activeOrg} onChange={(event) => setActiveOrg(event.target.value)}>
            {orgs.map((org) => <option key={org.orgId} value={org.orgId}>{org.name}</option>)}
          </select>
        </label>
      )}

      {!canManage && !loading && (
        <div className="settings-note settings-note--warn">Your role can view PR reviews, but review automation requires the <code>triggers:manage</code> capability.</div>
      )}
      {error && <div className="settings-note settings-note--error" role="alert">{error}</div>}

      {canManage && !loading && !integration && (
        <PremiumCard level={2}>
          <div className="settings-cardhead"><div><h3>GitHub App required</h3><div className="settings-hint">Automatic review needs the organization GitHub App. Connected-account repositories remain available for on-demand reviews.</div></div></div>
          <Link className="settings-link" href="/integrations">Configure connections</Link>
        </PremiumCard>
      )}

      {canManage && integration && (
        <>
          <PremiumCard level={2}>
            <div className="settings-cardhead"><div><h3>Organization defaults</h3><div className="settings-hint">Applied to automatically reviewed repositories unless a repository overrides them.</div></div></div>
            {POLICY_META.map(({ field, label, hint }) => (
              <div className="settings-item" key={field}>
                <div className="min-w-0"><span className="settings-row__title">{label}</span><div className="settings-row__sub">{hint}</div></div>
                <Segmented label={label} value={(defaults[field] ?? POLICY_DEFAULTS[field]) ? "on" : "off"} disabled={configBusy} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} onChange={(value) => void setDefault(field, value === "on")} />
              </div>
            ))}
            <div className="settings-item">
              <div><span className="settings-row__title">Code review trigger</span><div className="settings-row__sub">Manual uses <code>/code-review</code>; automatic also runs on pull-request events.</div></div>
              <Segmented label="Default code review trigger" value={defaults.codeReviewTrigger === "auto" ? "auto" : "manual"} disabled={configBusy} options={[{ value: "manual", label: "Manual" }, { value: "auto", label: "Automatic" }]} onChange={(value) => void setCodeTrigger(null, value)} />
            </div>
            <div className="settings-item">
              <div><span className="settings-row__title">Developers can run reviews</span><div className="settings-row__sub">Allow developers to queue Security review, Code review, or both from product surfaces.</div></div>
              <Segmented label="Developers can run reviews" value={defaults.developersCanRun ? "on" : "off"} disabled={configBusy} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} onChange={(value) => void patchConfig({ reviewPolicyDefaults: { ...defaults, developersCanRun: value === "on" } }, "default:developers-run")} />
            </div>
          </PremiumCard>

          <PremiumCard level={2} className="review-automation__manual-card">
            <div className="settings-cardhead"><div><h3>GitHub command access</h3><div className="settings-hint">Minimum repository permission for slash commands. Named users can bypass the minimum.</div></div></div>
            <div className="review-automation__manual-grid">
              <label className="settings-label">Minimum permission
                <select className="settings-select" disabled={configBusy} value={runners.minPermission ?? "maintain"} onChange={(event) => void setManualRunners(event.target.value as "admin" | "maintain" | "write", runnerAllowlist)}>
                  <option value="admin">Admin</option><option value="maintain">Maintain</option><option value="write">Write</option>
                </select>
              </label>
              <label className="settings-label">GitHub allowlist
                <input className="settings-input" disabled={configBusy} value={runnerAllowlist} onChange={(event) => setRunnerAllowlist(event.target.value)} onBlur={() => void setManualRunners(runners.minPermission ?? "maintain", runnerAllowlist)} placeholder="login-a, login-b" />
              </label>
            </div>
          </PremiumCard>

          <PremiumCard level={2} className="review-automation__repositories-card">
            <div className="settings-cardhead">
              <div><h3>Repository automation</h3><div className="settings-hint">{linked === null ? "All App-accessible repositories are automatic. Turn one off to create an explicit allowlist." : `${automaticCount} of ${repos.length} App-accessible repositories are automatic.`}</div></div>
              <span className="settings-badge settings-badge--muted">{automaticCount} automatic</span>
            </div>
            <input className="settings-input review-automation__search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search repositories" />
            <div className="review-automation__repository-list">
              {shown.length === 0 ? (
                <div className="settings-empty-inline">{repos.length ? `No repositories match “${search}”.` : "No App-accessible repositories. Grant repository access from Connections."}</div>
              ) : shown.map((repo) => {
                const automatic = isAutomatic(repo.fullName);
                const repoPolicy = policies[repo.fullName] ?? {};
                return (
                  <details className="review-automation__repository" key={repo.fullName}>
                    <summary>
                      <span className="review-automation__repository-name" title={repo.fullName}>{repo.fullName}{repo.private && <small>Private</small>}</span>
                      <span className="review-automation__repository-actions">
                        <span className="settings-hint">{automatic ? "Automatic" : "On demand"}</span>
                        <PremiumButton size="small" variant={automatic ? "ghost" : "primary"} disabled={configBusy} onClick={(event) => { event.preventDefault(); void setAutomatic(repo, !automatic); }}>
                          {busy === `repo:${repo.fullName}:automatic` ? "Saving…" : automatic ? "Turn off" : "Turn on"}
                        </PremiumButton>
                      </span>
                    </summary>
                    <div className="review-automation__overrides">
                      <div className="settings-row__sub">Optional overrides for this repository</div>
                      <div className="review-automation__override-row">
                        <span>Code review trigger</span>
                        <Segmented label={`${repo.fullName} code review trigger`} value={repoPolicy.codeReviewTrigger === "auto" ? "auto" : "manual"} disabled={configBusy || !automatic} options={[{ value: "manual", label: "Manual" }, { value: "auto", label: "Automatic" }]} onChange={(value) => void setCodeTrigger(repo.fullName, value)} />
                      </div>
                      {POLICY_META.map(({ field, label }) => {
                        const override = repoPolicy[field];
                        const value = override === undefined ? "default" : override ? "on" : "off";
                        return (
                          <div className="review-automation__override-row" key={field}>
                            <span>{label}</span>
                            <Segmented label={`${repo.fullName} ${label}`} value={value} disabled={configBusy || !automatic} options={[{ value: "default", label: `Default (${(defaults[field] ?? POLICY_DEFAULTS[field]) ? "On" : "Off"})` }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} onChange={(next) => void setRepositoryPolicy(repo.fullName, field, next === "default" ? undefined : next === "on")} />
                          </div>
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          </PremiumCard>
        </>
      )}

      {loading && <div className="settings-empty-inline">Loading review automation…</div>}
    </div>
  );
}

export default function ReviewAutomationPage() {
  return <AuthGuard><ReviewAutomationInner /></AuthGuard>;
}
