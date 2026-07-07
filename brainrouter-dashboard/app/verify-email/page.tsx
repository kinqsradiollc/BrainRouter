"use client";

/** Email-verification landing page (public). Consumes the ?token= link. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { BASE_URL } from "../../lib/client";
import { PremiumButton } from "../../components/PremiumButton";

export default function VerifyEmailPage() {
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token) { setState("error"); setMsg("This link is missing its verification token."); return; }
    fetch(`${BASE_URL}/api/auth/verify-email`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.verified) setState("ok");
        else { setState("error"); setMsg(j.error ?? "This verification link is invalid or expired."); }
      })
      .catch(() => { setState("error"); setMsg("Could not reach the server. Try again shortly."); });
  }, []);

  return (
    <div className="authflow-shell">
      <div className="authflow-card">
        <h1 className="authflow-title">
          {state === "working" ? "Verifying…" : state === "ok" ? "Email verified" : "Verification failed"}
        </h1>
        <p className="authflow-text">
          {state === "working" ? "Confirming your email address." : state === "ok" ? "Your email address is confirmed. You're all set." : msg}
        </p>
        <div className="authflow-actions">
          <Link href="/overview"><PremiumButton variant="primary">Go to dashboard</PremiumButton></Link>
        </div>
      </div>
    </div>
  );
}
