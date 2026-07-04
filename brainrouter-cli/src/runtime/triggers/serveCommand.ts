/**
 * MC-B1 — pure helpers behind `brainrouter serve --triggers` (kept
 * side-effect-free so the default-deny gating is unit-testable without
 * binding a socket or touching config on disk).
 */

/** The resolved `cli.triggers` view the serve command consumes. */
export interface ServeTriggersKnobs {
  enabled: boolean;
  port: number;
  host: string;
  githubSecret: string;
  allowedRepos: string[];
}

export interface ServeInvocationOptions {
  triggers?: boolean;
  port?: string | number;
  host?: string;
}

/**
 * DEFAULT-DENY gate: `serve` starts nothing unless `--triggers` was passed
 * AND `cli.triggers.enabled` is explicitly true. Returns the user-facing
 * error line, or null when the invocation may proceed.
 */
export function validateServeInvocation(
  options: ServeInvocationOptions,
  knobs: ServeTriggersKnobs,
): string | null {
  if (options.triggers !== true) {
    return 'Nothing to serve: pass --triggers to start the trigger ingress endpoint.';
  }
  if (knobs.enabled !== true) {
    return 'Trigger ingress is disabled (cli.triggers.enabled is false — the default). ' +
      'Set cli.triggers.enabled to true in config.json to opt in.';
  }
  return null;
}

/** Resolve the effective bind host/port: CLI flags override the knobs. */
export function resolveServeBind(
  options: ServeInvocationOptions,
  knobs: ServeTriggersKnobs,
): { host: string; port: number } {
  const host = typeof options.host === 'string' && options.host.trim()
    ? options.host.trim()
    : knobs.host;
  const rawPort = options.port != null ? parseInt(String(options.port), 10) : NaN;
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : knobs.port;
  return { host, port };
}

/** Post-start warnings (never fatal): empty allowlist / missing secret. */
export function serveStartupWarnings(knobs: ServeTriggersKnobs, githubSecret: string): string[] {
  const warnings: string[] = [];
  if (knobs.allowedRepos.length === 0) {
    warnings.push('cli.triggers.allowedRepos is empty — every event will be accepted-but-dropped.');
  }
  if (!githubSecret) {
    warnings.push('No GitHub webhook secret configured (cli.triggers.githubSecret or the GitHub connector\'s webhookSecret) — github deliveries will be rejected (401).');
  }
  return warnings;
}
