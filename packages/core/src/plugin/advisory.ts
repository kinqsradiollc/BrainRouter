/**
 * ADR-047 D4 (P4b) — a vetted install: the advisory check.
 *
 * The allowlist (P4a) answers "is this org ALLOWED to install this plugin?". The
 * advisory check answers a different question — "does an open vulnerability /
 * malware database already KNOW something bad about it?" — and refuses to let a
 * plugin with a published advisory install *silently*.
 *
 * The gate is policy-driven and OFF by default, so an org that never opts in
 * behaves exactly as before (no network call, no behaviour change):
 *
 *  - `off`   — no check (default).
 *  - `warn`  — check best-effort; a hit is surfaced as a warning but the install
 *              proceeds. Failing to reach the advisory service also just warns
 *              (fails OPEN) — a flaky lookup must not become a denial of service.
 *  - `block` — a hit REFUSES the install, citing the advisory; a lookup that
 *              cannot complete still fails open (warns), because "we could not
 *              check" is not the same as "we found something".
 *
 * The advisory SOURCE is injected (`PluginAdvisorySource`) so this is testable
 * without a network, and so a deployment can point it at its own feed. The
 * default source queries the public OSV database, which needs no key.
 */
import type { MarketplacePluginEntry } from './marketplace.js';

export type PluginAdvisoryPolicy = 'off' | 'warn' | 'block';

export interface PluginAdvisory {
  /** Advisory id (e.g. an OSV / GHSA / CVE identifier). */
  id: string;
  summary?: string;
  severity?: string;
  url?: string;
}

/** A best-effort advisory lookup for one plugin. Returns [] when it finds nothing OR cannot check. */
export type PluginAdvisorySource = (entry: MarketplacePluginEntry) => Promise<PluginAdvisory[]>;

export interface AdvisoryVerdict {
  verdict: 'ok' | 'warn' | 'block';
  findings: PluginAdvisory[];
  /** Human-readable line naming the advisories, for warn/block. */
  message?: string;
}

function citation(entry: MarketplacePluginEntry, findings: PluginAdvisory[]): string {
  const ids = findings.map((f) => f.id).filter(Boolean);
  const list = ids.length ? ids.join(', ') : 'an advisory';
  return `plugin "${entry.name}" has a published advisory (${list})`;
}

/**
 * Evaluate the advisory gate for one plugin under a policy. Never throws: a
 * source that rejects is treated as "could not check" and fails OPEN (a warn),
 * so an unreachable advisory service can never wedge every install.
 */
export async function evaluatePluginAdvisory(
  entry: MarketplacePluginEntry,
  policy: PluginAdvisoryPolicy,
  source: PluginAdvisorySource,
): Promise<AdvisoryVerdict> {
  if (policy === 'off') return { verdict: 'ok', findings: [] };

  let findings: PluginAdvisory[];
  try {
    findings = await source(entry);
  } catch (err) {
    return {
      verdict: 'warn',
      findings: [],
      message: `advisory check for "${entry.name}" could not complete (${err instanceof Error ? err.message : String(err)}); proceeding`,
    };
  }

  if (findings.length === 0) return { verdict: 'ok', findings: [] };

  const message = `${citation(entry, findings)} — ${policy === 'block' ? 'refused by advisory policy (advisoryPolicy: block).' : 'proceeding (advisoryPolicy: warn).'}`;
  return { verdict: policy === 'block' ? 'block' : 'warn', findings, message };
}

/**
 * The default advisory source: the public OSV database (api.osv.dev, no key).
 *
 * OSV is queried by (ecosystem, name): a manifest entry may declare its
 * `package` precisely; absent that, we fall back to the plugin's own name in the
 * npm ecosystem (the common case for a JS plugin), which is a heuristic, not a
 * guarantee — hence the sane default policy is `warn`, not `block`. Best-effort
 * with a short timeout; any failure returns [] so `evaluatePluginAdvisory`
 * fails open.
 */
export const osvAdvisorySource: PluginAdvisorySource = async (entry) => {
  const pkg = entry.package ?? { ecosystem: 'npm', name: entry.name };
  if (!pkg.name?.trim()) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch('https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: { ecosystem: pkg.ecosystem, name: pkg.name },
        ...(entry.version ? { version: entry.version } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { vulns?: Array<{ id?: string; summary?: string; severity?: unknown }> };
    return (data.vulns ?? [])
      .filter((v) => typeof v.id === 'string' && v.id)
      .map((v) => ({
        id: v.id as string,
        summary: typeof v.summary === 'string' ? v.summary : undefined,
        url: `https://osv.dev/vulnerability/${v.id}`,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};
