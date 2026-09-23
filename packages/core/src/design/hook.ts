/**
 * The design hook (ADR-056 D-B2): the detector runs where the edit happens.
 *
 * Two tiers, one knob (`cli.design.hook`, default `off`):
 *   - `immediate` — after every write tool that touched a UI file, that one file
 *     is checked (≤ 5 findings, a few hundred bytes);
 *   - `full`      — the immediate tier PLUS, at turn end, a full pass over every
 *     UI file the turn wrote (≤ 15 files, ≤ 8 kB of findings).
 * Findings enter the NEXT turn through the stop-context channel ADR-048's
 * blast radius already uses — never the in-flight message array (ADR-041 D4)
 * — so the agent that just edited a page is told what the page now says
 * before it continues. The hook NEVER denies a write, never throws into a
 * turn, and is silent for a silent (delegated) agent or a reviewed-execution
 * turn, where injected context is not the runtime's to add. Deterministic:
 * with the knob off nothing runs and a turn is byte-identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getCliKnobs } from '../config/config.js';
import { detectDesign, type DesignFinding, type DesignInputFile } from './detect/engine.js';
import { readDesignSystemTokens } from './detect/designSystem.js';
import { readDesignSuppressions } from './detect/suppressions.js';

export const DESIGN_HOOK_LIMITS = {
  immediateFindings: 5,
  immediateChars: 1_200,
  fullFiles: 15,
  fullChars: 8_000,
  maxFileBytes: 512 * 1024,
} as const;

const UI_EXT = /\.(html?|xhtml|svelte|vue|jsx|tsx|astro|mdx|css|scss|less)$/i;

export type DesignHookTier = 'off' | 'immediate' | 'full';

/** Is the path a UI file the detector can model? */
export function isDesignHookTarget(filePath: string): boolean {
  return UI_EXT.test(filePath);
}

function readInput(workspaceRoot: string, filePath: string): DesignInputFile | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(abs);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    if (fs.statSync(resolved).size > DESIGN_HOOK_LIMITS.maxFileBytes) return null;
    return { path: path.relative(root, resolved).split(path.sep).join('/'), content: fs.readFileSync(resolved, 'utf8') };
  } catch {
    return null;
  }
}

function line(f: DesignFinding): string {
  return `- ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}${f.snippet ? ` ${f.snippet}` : ''} — ${f.message}`;
}

/**
 * The findings block for a set of written files, bounded for its tier; '' when
 * nothing qualifies. Pure apart from reading the files, tokens, and suppressions.
 */
export function designHookBlock(workspaceRoot: string, written: string[], tier: 'immediate' | 'full'): string {
  const targets = [...new Set(written.filter(isDesignHookTarget))].slice(0, tier === 'full' ? DESIGN_HOOK_LIMITS.fullFiles : 1);
  const files = targets.map((p) => readInput(workspaceRoot, p)).filter((f): f is DesignInputFile => !!f);
  if (!files.length) return '';
  const result = detectDesign(files, { tokens: readDesignSystemTokens(workspaceRoot), suppressions: readDesignSuppressions(workspaceRoot) });
  const counted = result.findings.filter((f) => !f.advisory);
  if (!counted.length) return '';
  const max = tier === 'full' ? counted.length : DESIGN_HOOK_LIMITS.immediateFindings;
  const cap = tier === 'full' ? DESIGN_HOOK_LIMITS.fullChars : DESIGN_HOOK_LIMITS.immediateChars;
  const head = `Design check (${tier}) on ${files.length} file${files.length === 1 ? '' : 's'} you wrote: ${result.errors} error${result.errors === 1 ? '' : 's'}, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}. Verify each in context; fix what holds, or record a suppression with a reason in .brainrouter/design-detector.json.`;
  const lines: string[] = [head];
  let used = head.length;
  let shown = 0;
  for (const f of counted) {
    if (shown >= max) break;
    const l = line(f);
    if (used + l.length + 1 > cap) break;
    lines.push(l); used += l.length + 1; shown++;
  }
  if (shown < counted.length) lines.push(`- … ${counted.length - shown} more (run design_detect for the full list)`);
  return lines.join('\n');
}

/** The runtime surface the hook reads and writes — the same two fields the Atlas tap uses. */
export interface DesignHookAgent {
  readonly workspaceRoot: string;
  readonly silent: boolean;
  readonly reviewSourceSafety: boolean;
  pendingStopContext: string | null | undefined;
}

function inject(agent: DesignHookAgent, block: string): void {
  if (!block) return;
  agent.pendingStopContext = agent.pendingStopContext ? `${agent.pendingStopContext}\n${block}` : block;
}

/** Immediate tier: called right after a write tool recorded `filePath`. Never throws. */
export function designHookAfterWrite(agent: DesignHookAgent, filePath: string): void {
  try {
    const tier = getCliKnobs().design.hook;
    if (tier === 'off' || agent.silent || agent.reviewSourceSafety || !isDesignHookTarget(filePath)) return;
    inject(agent, designHookBlock(agent.workspaceRoot, [filePath], 'immediate'));
  } catch { /* a design check enriches a turn; it must never break one */ }
}

/** Full tier: called at turn end with every path the turn wrote. Never throws. */
export function designHookAtTurnEnd(agent: DesignHookAgent, written: string[]): void {
  try {
    if (getCliKnobs().design.hook !== 'full' || agent.silent || agent.reviewSourceSafety) return;
    inject(agent, designHookBlock(agent.workspaceRoot, written, 'full'));
  } catch { /* never break a turn */ }
}
