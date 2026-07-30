"use client";

/**
 * ADR-014 Phase F — admin console. System-admin oversight of every Team: plan,
 * seats used vs the plan cap, project count, and owner. Admin-only (the API 403s
 * for non-admins).
 */
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { adminApi, type OrgStats } from "../../lib/adminApi";
import { InlineLoading } from "../../components/LoadingSpinner";

function fmtLimit(used: number, limit: number | null): string {
  return limit === null ? `${used} / ∞` : `${used} / ${limit}`;
}

function AdminOrgsInner() {
  const [orgs, setOrgs] = useState<OrgStats[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listAllOrgs();
      setOrgs(res.orgs ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load — admin only");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="settings-page">
      <PageHeader title="All organizations" description="Every team on this deployment — plan, seats used vs the plan cap, projects, and owner." />
      {error && <div className="settings-note settings-note--error">{error}</div>}

      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)", overflowX: "auto" }}>
        {loading ? (
          <InlineLoading label="Loading…" />
        ) : orgs.length === 0 ? (
          <div className="settings-empty-inline">No organizations.</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr><th>Team</th><th>Plan</th><th>Seats</th><th>Projects</th><th>Owner</th></tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.orgId}>
                  <td>
                    <div className="admin-table__name">{o.name}</div>
                    <div className="admin-table__sub">{o.slug}</div>
                  </td>
                  <td><span className="settings-badge settings-badge--muted">{o.plan}</span></td>
                  <td className={o.overSeats ? "admin-table__over" : ""}>{fmtLimit(o.memberCount, o.seatLimit)}</td>
                  <td>{fmtLimit(o.projectCount, o.projectLimit)}</td>
                  <td className="admin-table__sub">{o.ownerId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PremiumCard>
    </div>
  );
}

export default function AdminOrgsPage() {
  return <AuthGuard><AdminOrgsInner /></AuthGuard>;
}
