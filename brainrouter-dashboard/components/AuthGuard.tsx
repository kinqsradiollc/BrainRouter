"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isAuthenticated } from "../lib/client-auth";
import { STATIC_PRESENTATION, isPresentationRoute } from "../lib/presentation";
import { LoadingSpinner } from "./LoadingSpinner";

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Presentation-only mode: only the marketing routes exist. Everything
    // else (auth + dashboard) redirects home — no API, no sign-in.
    if (STATIC_PRESENTATION) {
      if (!isPresentationRoute(pathname)) {
        router.replace("/");
        return;
      }
      setReady(true);
      return;
    }

    const authed = isAuthenticated();
    // Public routes (no sign-in): marketing home, auth, about, status, and the
    // email-link landing pages (verify / reset / accept-invite).
    const PUBLIC = ["/", "/auth", "/about", "/status", "/verify-email", "/reset-password", "/accept-invite"];
    if (!authed && !PUBLIC.includes(pathname)) {
      router.replace("/auth");
      return;
    }
    setReady(true);
  }, [pathname, router]);

  if (!ready) return <LoadingSpinner />;
  return <>{children}</>;
}
