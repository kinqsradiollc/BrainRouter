"use client";

/** Password-reset landing page (public). Consumes the ?token= link + sets a new password. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { BASE_URL } from "../../lib/client";
import { PremiumButton } from "../../components/PremiumButton";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"form" | "saving" | "ok" | "error">("form");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(t);
    if (!t) { setState("error"); setMsg("This link is missing its reset token."); }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setMsg("Password must be at least 8 characters."); return; }
    setState("saving");
    try {
      const r = await fetch(`${BASE_URL}/api/auth/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) setState("ok");
      else { setState("error"); setMsg(j.error ?? "This reset link is invalid or expired."); }
    } catch {
      setState("error"); setMsg("Could not reach the server. Try again shortly.");
    }
  }

  return (
    <div className="authflow-shell">
      <div className="authflow-card">
        <h1 className="authflow-title">{state === "ok" ? "Password updated" : "Reset your password"}</h1>
        {state === "ok" ? (
          <>
            <p className="authflow-text">Your password has been changed. Sign in with your new password.</p>
            <div className="authflow-actions"><Link href="/auth"><PremiumButton variant="primary">Sign in</PremiumButton></Link></div>
          </>
        ) : state === "error" && !token ? (
          <p className="authflow-text">{msg}</p>
        ) : (
          <form className="authflow-form" onSubmit={submit}>
            <label className="settings-label">New password
              <input className="settings-input" type="password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {msg && <p className="settings-note settings-note--error" style={{ marginTop: 0 }}>{msg}</p>}
            <div className="authflow-actions">
              <PremiumButton type="submit" variant="primary" disabled={state === "saving" || password.length < 8}>
                {state === "saving" ? "Saving…" : "Set new password"}
              </PremiumButton>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
