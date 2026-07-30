"use client";

/** Invitation-acceptance landing page. Consumes the ?token= link; requires sign-in. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApi } from "../../lib/adminApi";
import { isAuthenticated } from "../../lib/client-auth";
import { PremiumButton } from "../../components/PremiumButton";

export default function AcceptInvitePage() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [state, setState] = useState<"idle" | "accepting" | "ok" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [orgName, setOrgName] = useState("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(t);
    setAuthed(isAuthenticated());
    if (!t) { setState("error"); setMsg("This link is missing its invitation token."); }
  }, []);

  async function accept() {
    setState("accepting");
    try {
      const r = await adminApi.acceptInvite(token);
      setOrgName(r.name ?? "the team");
      setState("ok");
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : "This invitation is invalid, expired, or already used.");
    }
  }

  const returnTo = typeof window !== "undefined" ? encodeURIComponent(window.location.pathname + window.location.search) : "";

  return (
    <div className="authflow-shell">
      <div className="authflow-card">
        <h1 className="authflow-title">
          {state === "ok" ? "Invitation accepted" : "Team invitation"}
        </h1>
        {state === "ok" ? (
          <>
            <p className="authflow-text">You've joined {orgName}. It's now available in your Organizations.</p>
            <div className="authflow-actions"><Link href="/organizations"><PremiumButton variant="primary">View organizations</PremiumButton></Link></div>
          </>
        ) : !token ? (
          <p className="authflow-text">{msg}</p>
        ) : !authed ? (
          <>
            <p className="authflow-text">You've been invited to join a team on BrainRouter. Sign in with the invited email to accept.</p>
            <div className="authflow-actions"><Link href={`/auth?returnTo=${returnTo}`}><PremiumButton variant="primary">Sign in to accept</PremiumButton></Link></div>
          </>
        ) : (
          <>
            <p className="authflow-text">You've been invited to join a team on BrainRouter.</p>
            {msg && <p className="settings-note settings-note--error">{msg}</p>}
            <div className="authflow-actions">
              <PremiumButton variant="primary" disabled={state === "accepting"} onClick={accept}>
                {state === "accepting" ? "Accepting…" : "Accept invitation"}
              </PremiumButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
