/**
 * Static presentation mode.
 *
 * When `NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION=true`, the dashboard runs as
 * a pure product preview: only the marketing routes render, and sign-in/sign-up,
 * the authenticated dashboard, and all API calls are disabled. This lets the app
 * be deployed standalone (no backend) as a preview; locally, leave it off to use
 * the full dashboard.
 *
 * NEXT_PUBLIC_ is required so the flag is readable in client components.
 */
export const STATIC_PRESENTATION =
  (process.env.NEXT_PUBLIC_BRAINROUTER_STATIC_PRESENTATION ?? "").toLowerCase() === "true";

/** Routes that remain available in presentation mode (marketing surface). */
export const PRESENTATION_ROUTES = new Set(["/", "/about"]);

export function isPresentationRoute(pathname: string): boolean {
  return PRESENTATION_ROUTES.has(pathname);
}
