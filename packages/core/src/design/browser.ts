/**
 * The browser design engine, core side (ADR-056 D-B1).
 *
 * The desktop's in-app browser runs the computed-style rules — contrast
 * against the composited background, clipped or covered text, first-viewport
 * horizontal overflow, content hidden at rest, tiny text, small targets — as
 * the `page.designAudit` control command. This module asks for that audit
 * through the browser control port, folds the answer into the detector's
 * finding shape, and honours the workspace suppressions the same way the
 * static engine does. With no port (the CLI, a silent agent) it says so; it
 * never pretends a static read was a browser read.
 */
import { DESIGN_RULES, DESIGN_RULES_VERSION } from './detect/rules.js';
import { isSuppressed, type DesignSuppressions, EMPTY_SUPPRESSIONS } from './detect/suppressions.js';
import type { DesignFinding } from './detect/engine.js';

export interface BrowserDesignPort { request(command: unknown, options?: { signal?: AbortSignal }): Promise<{ ok?: boolean; data?: unknown; error?: unknown } | null | undefined> }

export interface BrowserAuditRaw { url?: string; viewport?: { width: number; height: number }; scanned?: number; findings?: Array<{ rule?: string; message?: string; selector?: string; snippet?: string; box?: { x: number; y: number; w: number; h: number } }>; truncated?: boolean }

export interface BrowserDesignAudit {
  url: string;
  viewport: { width: number; height: number } | null;
  scanned: number;
  findings: DesignFinding[];
  suppressed: Array<DesignFinding & { reason: string }>;
  truncated: boolean;
  catalogVersion: string;
}

export interface BrowserDesignAuditOptions { tabId?: string; rules?: string[]; maxFindings?: number; suppressions?: DesignSuppressions; timeoutMs?: number }

export const BROWSER_ENGINE_RULE_IDS: readonly string[] = DESIGN_RULES.filter((r) => r.engine === 'browser' || r.engine === 'both').map((r) => r.id);

/** Ask the in-app browser for a computed-style audit and return detector findings; throws when the port refuses. */
export async function requestBrowserDesignAudit(port: BrowserDesignPort, options: BrowserDesignAuditOptions = {}): Promise<BrowserDesignAudit> {
  const rules = (options.rules ?? []).filter((r) => BROWSER_ENGINE_RULE_IDS.includes(r));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let res;
  try {
    res = await port.request({ kind: 'page.designAudit', ...(options.tabId ? { tabId: options.tabId } : {}), ...(rules.length ? { rules } : {}), ...(options.maxFindings ? { maxFindings: options.maxFindings } : {}) }, { signal: controller.signal });
  } finally { clearTimeout(timer); }
  if (!res || res.ok === false) throw new Error(`the in-app browser refused the design audit${res && 'error' in res && res.error ? `: ${typeof res.error === 'string' ? res.error : JSON.stringify(res.error)}` : ''}`);
  const raw = (res.data ?? {}) as BrowserAuditRaw;
  const url = typeof raw.url === 'string' ? raw.url.slice(0, 200) : 'about:blank';
  const file = `browser:${url}`;
  const suppressions = options.suppressions ?? EMPTY_SUPPRESSIONS;
  const findings: DesignFinding[] = []; const suppressed: Array<DesignFinding & { reason: string }> = [];
  for (const f of raw.findings ?? []) {
    const rule = DESIGN_RULES.find((r) => r.id === f.rule && (r.engine === 'browser' || r.engine === 'both'));
    if (!rule) continue;
    const snippet = [f.selector, f.snippet ? `“${String(f.snippet).slice(0, 60)}”` : ''].filter(Boolean).join(' ').slice(0, 160);
    const finding: DesignFinding = {
      rule: rule.id, severity: rule.severity, category: rule.category, file,
      ...(snippet ? { snippet } : {}),
      message: String(f.message ?? rule.description).slice(0, 300),
      ...(rule.advisory ? { advisory: true } : {}), engine: 'browser',
    } as DesignFinding;
    const s = isSuppressed(suppressions, rule.id, file);
    if (s.suppressed) suppressed.push({ ...finding, reason: s.reason ?? 'suppressed' }); else findings.push(finding);
  }
  return { url, viewport: raw.viewport ?? null, scanned: raw.scanned ?? 0, findings, suppressed, truncated: raw.truncated === true, catalogVersion: DESIGN_RULES_VERSION };
}

/** The sentence a head without a browser prints instead of pretending. */
export const BROWSER_ENGINE_UNAVAILABLE = 'Browser engine unavailable here (no in-app browser) — static results only. Run design_detect with browser: true from the desktop for computed-style checks (contrast, clipped text, horizontal overflow, hidden-at-rest).';
