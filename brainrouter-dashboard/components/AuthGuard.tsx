"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { STATIC_PRESENTATION, isPresentationRoute } from "../lib/presentation";
import { LoadingSpinner } from "./LoadingSpinner";

interface AuthGuardProps {
  children: React.ReactNode;
}

// Public routes (no sign-in): marketing home, auth, about, status, and the
// email-link landing pages (verify / reset / accept-invite).
const PUBLIC = ["/", "/auth", "/about", "/status", "/verify-email", "/reset-password", "/accept-invite"];

export function AuthGuard({ children }: AuthGuardProps) {
  const pathname = usePathname();
  const router = useRouter();
  // ADR-037 D-2 — the session is a cookie now, resolved asynchronously by
  // AuthProvider (httpOnly cookie → /refresh → /me). Gate on its state, NOT a
  // synchronous localStorage check (which no longer exists), so a valid
  // cookie session is never bounced to /auth while it is still resolving.
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    // Presentation-only mode: only the marketing routes exist. Everything
    // else (auth + dashboard) redirects home — no API, no sign-in.
    if (STATIC_PRESENTATION) {
      if (!isPresentationRoute(pathname)) router.replace("/");
      return;
    }
    if (isLoading) return; // wait for the cookie session to resolve
    if (!isAuthenticated && !PUBLIC.includes(pathname)) {
      router.replace("/auth");
    }
  }, [pathname, router, isAuthenticated, isLoading]);

  if (STATIC_PRESENTATION) {
    return isPresentationRoute(pathname) ? <>{children}</> : <LoadingSpinner />;
  }
  // Hold protected routes behind the spinner until the session resolves; public
  // routes render immediately.
  if (isLoading && !PUBLIC.includes(pathname)) return <LoadingSpinner />;
  return <>{children}</>;
}
