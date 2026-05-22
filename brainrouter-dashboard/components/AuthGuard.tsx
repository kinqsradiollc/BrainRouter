"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isAuthenticated } from "../lib/client-auth";
import { LoadingSpinner } from "./LoadingSpinner";

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const authed = isAuthenticated();
    if (!authed && pathname !== "/auth" && pathname !== "/" && pathname !== "/about") {
      router.replace("/auth");
      return;
    }
    setReady(true);
  }, [pathname, router]);

  if (!ready) return <LoadingSpinner />;
  return <>{children}</>;
}
