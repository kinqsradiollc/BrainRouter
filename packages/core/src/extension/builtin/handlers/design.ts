// ADR-056 D-B1 — `design_detect`: run the deterministic design detector over
// workspace UI files (or a supplied markup string) and return findings in the
// review vocabulary. No model, no network; every path is resolved under the
// workspace root and refused when it escapes it. `design.md` tokens (when the
// workspace has them) make the design-system rules live; suppressions from
// `.brainrouter/design-detector.json` are honoured and REPORTED, so a silenced
// finding is still visible as silenced.

import { detectDesign } from '../../../design/detect/engine.js';
import { collectDesignFiles } from '../../../design/detect/files.js';
import { readDesignSystemTokens } from '../../../design/detect/designSystem.js';
import { readDesignSuppressions } from '../../../design/detect/suppressions.js';
import { isDesignRuleId } from '../../../design/detect/rules.js';
import type { BuiltinToolHandler } from './registry.js';

const MAX_FINDINGS = 60;

export const designHandlers: Record<string, BuiltinToolHandler> = {
  design_detect: async ({ args, host }) => {
    const rules = Array.isArray(args.rules) ? args.rules.filter(isDesignRuleId) : undefined;
    const tokens = args.designSystem === false ? null : readDesignSystemTokens(host.workspaceRoot);
    const suppressions = readDesignSuppressions(host.workspaceRoot);
    let files: Array<{ path: string; content: string }>;
    const notes: string[] = [];
    if (typeof args.html === 'string' && args.html.trim()) {
      files = [{ path: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'inline.html', content: args.html }];
    } else {
      const requested = Array.isArray(args.paths) ? args.paths.map((p: unknown) => String(p)) : ['.'];
      const collected = collectDesignFiles(host.workspaceRoot, requested);
      files = collected.files;
      for (const r of collected.refused) notes.push(`- skipped ${r.path}: ${r.reason}`);
      if (collected.truncated) notes.push('- file limit reached; narrow the paths to scan the rest');
    }
    if (!files.length) return `No UI files to check${notes.length ? `:\n${notes.join('\n')}` : ' (html, css, jsx/tsx, svelte, vue, astro).'}`;
    const result = detectDesign(files, { tokens, suppressions, ...(rules?.length ? { rules } : {}) });
    const head = `Design detector ${result.catalogVersion}: ${result.files} file(s), ${result.findings.length} finding(s) — ${result.errors} errors, ${result.warnings} warnings${result.findings.length - result.errors - result.warnings ? `, ${result.findings.length - result.errors - result.warnings} info/advisory` : ''}${tokens ? ` · design.md tokens from ${tokens.path}` : ' · no design.md tokens (design-system rules idle)'}.`;
    const lines = result.findings.slice(0, MAX_FINDINGS).map((f) =>
      `- [${f.severity}${f.advisory ? ', advisory' : ''}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}${f.snippet ? ` ${f.snippet}` : ''} — ${f.message} (${f.guideline})`);
    if (result.findings.length > MAX_FINDINGS) lines.push(`- … ${result.findings.length - MAX_FINDINGS} more`);
    if (result.suppressed.length) lines.push(`Suppressed ${result.suppressed.length}: ${result.suppressed.slice(0, 8).map((s) => `${s.rule}@${s.file} (${s.reason})`).join('; ')}${result.suppressed.length > 8 ? '; …' : ''}`);
    if (result.skipped.length) lines.push(`Not modelled (${result.skipped.length}): ${result.skipped.slice(0, 6).join(', ')}${result.skipped.length > 6 ? ', …' : ''}`);
    return [head, ...lines, ...notes].join('\n');
  },
};
