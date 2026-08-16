"use client";

/**
 * ADR-017 P3 — org/team setup wizard. A guided flow over the existing org APIs:
 * create (or join) a team → invite members with roles → link a repository →
 * confirm the team's scoped memory. Every step reuses adminApi; nothing new on
 * the backend. Members/repo steps are skippable and only shown to the creator.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "../../../components/AuthGuard";
import { PageHeader } from "../../../components/PageHeader";
import { PremiumCard } from "../../../components/PremiumCard";
import { PremiumButton } from "../../../components/PremiumButton";
import { adminApi, ORG_PLANS, type OrgPlan } from "../../../lib/adminApi";
import { useActiveOrg } from "../../../components/OrgWorkspaceProvider";

const INVITE_ROLES = ["admin", "developer", "viewer"];
type Step = 1 | 2 | 3 | 4;
const STEP_LABELS: Record<Step, string> = { 1: "Create or join", 2: "Invite members", 3: "Link a repository", 4: "Memory" };

function WizardInner() {
  const router = useRouter();
  const { refreshOrgs, setActiveOrg } = useActiveOrg();
  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<OrgPlan>("team");
  const [token, setToken] = useState("");
  const [orgId, setOrgId] = useState("");
  const [orgName, setOrgName] = useState("");
  const [invites, setInvites] = useState<{ email: string; role: string }[]>([{ email: "", role: "developer" }]);
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createOrJoin() {
    setBusy(true); setError("");
    try {
      if (mode === "create") {
        if (!name.trim()) { setError("Enter a team name."); return; }
        const { org } = await adminApi.createOrg(name.trim(), plan);
        setOrgId(org.orgId); setOrgName(org.name);
        await refreshOrgs();
        setStep(2);
      } else {
        if (!token.trim()) { setError("Paste your invite token."); return; }
        const res = await adminApi.acceptInvite(token.trim());
        setOrgId(res.orgId); setOrgName(res.name ?? "your team");
        await refreshOrgs();
        setStep(4); // a joiner isn't necessarily an admin — go straight to the summary
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  }

  async function sendInvites() {
    setBusy(true); setError("");
    try {
      for (const inv of invites) {
        if (inv.email.trim()) await adminApi.inviteMemberByEmail(orgId, inv.email.trim(), inv.role);
      }
      setStep(3);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to invite one or more members."); }
    finally { setBusy(false); }
  }

  async function linkRepo() {
    setBusy(true); setError("");
    try {
      if (repoUrl.trim()) await adminApi.createProject(orgId, { name: repoName.trim() || repoUrl.trim(), repoUrl: repoUrl.trim() });
      setStep(4);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to link the repository."); }
    finally { setBusy(false); }
  }

  function finish() {
    if (orgId) setActiveOrg(orgId);
    router.push("/memories");
  }

  return (
    <div className="settings-page">
      <PageHeader title="Set up a team" description="Create or join a team, invite people, connect a repository, and start sharing memory." />
      <div className="settings-hint" style={{ marginTop: "calc(-1 * var(--spacing-8))" }}>
        <Link href="/organizations" className="settings-link">← All organizations</Link>
      </div>

      {/* Step indicator */}
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: "var(--spacing-16)" }}>
        {([1, 2, 3, 4] as Step[]).map((n) => (
          <span key={n} className={`settings-badge ${n === step ? "settings-badge--active" : n < step ? "settings-badge--muted" : ""}`}>
            {n}. {STEP_LABELS[n]}
          </span>
        ))}
      </div>

      {error && <div className="settings-note settings-note--error" style={{ marginTop: "var(--spacing-12)" }}>{error}</div>}

      {step === 1 && (
        <PremiumCard level={2} style={{ marginTop: "var(--spacing-16)" }}>
          <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: "var(--spacing-12)" }}>
            <PremiumButton size="small" variant={mode === "create" ? "primary" : "ghost"} onClick={() => setMode("create")}>Create a team</PremiumButton>
            <PremiumButton size="small" variant={mode === "join" ? "primary" : "ghost"} onClick={() => setMode("join")}>Join with an invite</PremiumButton>
          </div>
          {mode === "create" ? (
            <>
              <label className="settings-label">Team name
                <input className="settings-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Platform" autoFocus />
              </label>
              <label className="settings-label" style={{ marginTop: "var(--spacing-12)" }}>Plan
                <select className="settings-select" value={plan} onChange={(e) => setPlan(e.target.value as OrgPlan)}>
                  {ORG_PLANS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
            </>
          ) : (
            <label className="settings-label">Invite token
              <input className="settings-input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the invite token from your email" autoFocus />
            </label>
          )}
          <div style={{ marginTop: "var(--spacing-16)" }}>
            <PremiumButton variant="primary" disabled={busy} onClick={createOrJoin}>{busy ? "Working…" : mode === "create" ? "Create team →" : "Join team →"}</PremiumButton>
          </div>
        </PremiumCard>
      )}

      {step === 2 && (
        <PremiumCard level={2} style={{ marginTop: "var(--spacing-16)" }}>
          <div className="settings-cardhead"><div><h3>Invite members to {orgName}</h3><div className="settings-hint">They&apos;ll get an email invite. You can always add more later.</div></div></div>
          {invites.map((inv, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2" style={{ marginTop: "var(--spacing-8)" }}>
              <input className="settings-input" style={{ flex: 1, minWidth: "16rem" }} type="email" value={inv.email} placeholder="teammate@company.com"
                onChange={(e) => setInvites((cur) => cur.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
              <select className="settings-select" value={inv.role} onChange={(e) => setInvites((cur) => cur.map((x, j) => j === i ? { ...x, role: e.target.value } : x))}>
                {INVITE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3" style={{ marginTop: "var(--spacing-12)" }}>
            <PremiumButton size="small" variant="ghost" onClick={() => setInvites((cur) => [...cur, { email: "", role: "developer" }])}>+ Add another</PremiumButton>
            <span style={{ flex: 1 }} />
            <PremiumButton variant="ghost" disabled={busy} onClick={() => setStep(3)}>Skip</PremiumButton>
            <PremiumButton variant="primary" disabled={busy} onClick={sendInvites}>{busy ? "Sending…" : "Send invites →"}</PremiumButton>
          </div>
        </PremiumCard>
      )}

      {step === 3 && (
        <PremiumCard level={2} style={{ marginTop: "var(--spacing-16)" }}>
          <div className="settings-cardhead"><div><h3>Link a repository</h3><div className="settings-hint">Its memory is scoped to {orgName}. You can manage repos anytime in Integrations → GitHub.</div></div></div>
          <label className="settings-label">Repository URL
            <input className="settings-input" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/acme/platform" />
          </label>
          <label className="settings-label" style={{ marginTop: "var(--spacing-12)" }}>Project name (optional)
            <input className="settings-input" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="Platform" />
          </label>
          <div className="flex flex-wrap items-center gap-3" style={{ marginTop: "var(--spacing-16)" }}>
            <span style={{ flex: 1 }} />
            <PremiumButton variant="ghost" disabled={busy} onClick={() => setStep(4)}>Skip</PremiumButton>
            <PremiumButton variant="primary" disabled={busy} onClick={linkRepo}>{busy ? "Linking…" : "Link & continue →"}</PremiumButton>
          </div>
        </PremiumCard>
      )}

      {step === 4 && (
        <PremiumCard level={2} style={{ marginTop: "var(--spacing-16)" }}>
          <div className="settings-cardhead"><div><h3>You&apos;re set up 🎉</h3><div className="settings-hint">{orgName}&apos;s memory is now scoped to the team.</div></div></div>
          <ul className="settings-hint" style={{ lineHeight: 1.8, paddingLeft: "1.1rem" }}>
            <li>Captures under this team are tagged with its org, workspace, and project scope.</li>
            <li>Team-shared memories appear under the <strong>Team</strong> scope on the Saved-knowledge page.</li>
            <li>Manage members in <Link href="/organizations" className="settings-link">Organizations</Link>, and repositories in <Link href="/integrations/github" className="settings-link">Integrations → GitHub</Link>.</li>
          </ul>
          <div className="flex flex-wrap items-center gap-3" style={{ marginTop: "var(--spacing-16)" }}>
            <PremiumButton variant="primary" onClick={finish}>Go to memory →</PremiumButton>
            <Link href="/organizations"><PremiumButton variant="ghost">Manage team</PremiumButton></Link>
          </div>
        </PremiumCard>
      )}
    </div>
  );
}

export default function OrgSetupWizardPage() {
  return (
    <AuthGuard>
      <WizardInner />
    </AuthGuard>
  );
}
