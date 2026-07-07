/**
 * Email-domain allowlist helpers (ADR-014 Phase B). Pure + dependency-free so the
 * membership routes and the (later) invitation flow share one gate, unit-tested in
 * isolation. Enterprise teams may restrict who can join to specific domains.
 */

/** Lowercased domain part of an email, or "" if malformed. */
export function emailDomain(email: string): string {
  const at = String(email).trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return "";
  return email.trim().toLowerCase().slice(at + 1);
}

/** Normalize a user-entered domain list: lowercase, strip a leading "@", dedupe, drop blanks. */
export function normalizeDomains(domains: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of domains) {
    const d = String(raw).trim().toLowerCase().replace(/^@/, "");
    if (d) seen.add(d);
  }
  return [...seen];
}

/**
 * True when `email` may join a team with `allowedDomains`. An EMPTY allowlist means
 * "no restriction" (everyone allowed). A non-empty list requires the email's domain
 * to match one entry exactly (subdomains are NOT implied — list them explicitly).
 */
export function domainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const list = normalizeDomains(allowedDomains);
  if (list.length === 0) return true;
  const d = emailDomain(email);
  return d !== "" && list.includes(d);
}
