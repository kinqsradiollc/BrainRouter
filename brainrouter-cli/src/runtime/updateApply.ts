import { execFile } from 'node:child_process';
import { checkForUpdate, type UpdateCheckResult } from './updateCheck.js';

/**
 * AUDITED-UPDATE (0.4.15) — turn the notice-only update check into an explicit,
 * dependency-audited apply. `brainrouter update` checks for a newer version,
 * runs `npm audit` on the candidate, and REFUSES to auto-install when the audit
 * reports critical advisories — surfacing them instead. Applying is always
 * user-initiated (a `--yes` flag), never a silent background install.
 *
 * The parse + decision are pure (unit-tested); the npm calls are injectable.
 */

const PKG = '@kinqs/brainrouter-cli';

export interface AuditSummary {
  critical: number;
  high: number;
  summary: string;
}

/** Parse `npm audit --json` into a compact summary. Pure; tolerant of shape drift. */
export function parseAuditJson(raw: string): AuditSummary {
  try {
    const j = JSON.parse(raw) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const v = j.metadata?.vulnerabilities ?? {};
    const critical = Number(v.critical ?? 0);
    const high = Number(v.high ?? 0);
    const total = Number(
      v.total ?? critical + high + Number(v.moderate ?? 0) + Number(v.low ?? 0) + Number(v.info ?? 0),
    );
    return { critical, high, summary: `${total} advisor${total === 1 ? 'y' : 'ies'} (critical ${critical}, high ${high})` };
  } catch {
    return { critical: 0, high: 0, summary: 'audit unavailable' };
  }
}

export interface UpdateDecision {
  current: string;
  latest: string;
  behind: boolean;
  audit: AuditSummary;
  /** True when the update must NOT auto-install (critical advisories present). */
  blocked: boolean;
  reason?: string;
  command: string;
}

/** Decide whether an update may auto-install, given the check + audit. Pure. */
export function decideUpdate(check: UpdateCheckResult, audit: AuditSummary): UpdateDecision {
  const blocked = check.behind && audit.critical > 0;
  return {
    current: check.current,
    latest: check.latest,
    behind: check.behind,
    audit,
    blocked,
    reason: blocked
      ? `refusing to auto-install: the update carries ${audit.critical} critical advisor${audit.critical === 1 ? 'y' : 'ies'} — review with \`npm audit\` before installing`
      : undefined,
    command: check.command,
  };
}

function npmAudit(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('npm', ['audit', '--json', '--omit=dev'], { timeout: timeoutMs }, (_err, stdout) => {
      // npm audit exits non-zero when advisories exist; the JSON is still on stdout.
      resolve(String(stdout || ''));
    });
  });
}

function npmInstallLatest(timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('npm', ['i', '-g', `${PKG}@latest`, '--ignore-scripts'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: String(stdout || '') + String(stderr || '') });
    });
  });
}

export interface AuditedUpdateResult {
  decision: UpdateDecision | null; // null when already up to date / check failed
  installed: boolean;
  installOutput?: string;
}

/**
 * Run the full audited-update flow. With `apply: false` (default) it only
 * reports the decision; with `apply: true` it installs ONLY when not blocked.
 * npm calls are injectable for tests.
 */
export async function runAuditedUpdate(opts: {
  apply?: boolean;
  auditTimeoutMs?: number;
  installTimeoutMs?: number;
  check?: () => Promise<UpdateCheckResult | null>;
  audit?: (timeoutMs: number) => Promise<string>;
  install?: (timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
} = {}): Promise<AuditedUpdateResult> {
  const check = await (opts.check ?? (() => checkForUpdate()))();
  if (!check || !check.behind) return { decision: check ? decideUpdate(check, { critical: 0, high: 0, summary: 'up to date' }) : null, installed: false };

  const auditRaw = await (opts.audit ?? npmAudit)(opts.auditTimeoutMs ?? 8000);
  const decision = decideUpdate(check, parseAuditJson(auditRaw));
  if (!opts.apply || decision.blocked) return { decision, installed: false };

  const res = await (opts.install ?? npmInstallLatest)(opts.installTimeoutMs ?? 120_000);
  return { decision, installed: res.ok, installOutput: res.output };
}
