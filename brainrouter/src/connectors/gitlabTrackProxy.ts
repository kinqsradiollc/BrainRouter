const GITLAB_TRACK_PATH = /^\/projects\/[^/]+\/(?:issues(?:\/\d+)?(?:\/notes)?|members\/all)$/;
const GITLAB_TRACK_QUERY = new Set(["state", "scope", "per_page", "page"]);

/**
 * Reject a self-managed GitLab host that points at the server's OWN loopback or
 * a cloud-metadata / link-local address — the SSRF credential-theft targets.
 * Private LAN ranges (10/8, 192.168, 172.16) stay allowed: a company's internal
 * GitLab legitimately lives there, and reaching it needs the tenant's own token.
 */
export function isSsrfBlockedHost(url: URL): boolean {
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\./.test(h) || h === "::1" || h === "0.0.0.0") return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.startsWith("fe80:") || h === "fd00:ec2::254") return true;
  return false;
}

/** Resolve one bounded GitLab Track API target. The connector fixes the HTTPS
 * origin; path and query allowlists prevent this server-side credential proxy
 * from becoming an arbitrary request or SSRF primitive. */
export function gitlabTrackProxyTarget(hostUrl: unknown, rawPath: unknown): string | null {
  const [pathname, query = ""] = String(rawPath ?? "").split("?");
  if (!GITLAB_TRACK_PATH.test(pathname)) return null;
  let root: URL;
  try { root = new URL(typeof hostUrl === "string" && hostUrl.trim() ? hostUrl.trim() : "https://gitlab.com"); }
  catch { return null; }
  if (root.protocol !== "https:" || root.username || root.password) return null;
  if (isSsrfBlockedHost(root)) return null;
  const basePath = root.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
  const safeQuery = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(query)) if (GITLAB_TRACK_QUERY.has(key)) safeQuery.set(key, value);
  const suffix = safeQuery.toString();
  return `${root.origin}${basePath}/api/v4${pathname}${suffix ? `?${suffix}` : ""}`;
}
