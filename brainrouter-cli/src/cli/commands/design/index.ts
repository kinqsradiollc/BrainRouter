/**
 * DESIGN (ADR-056 D-B1) — `/design` slash command: the deterministic half.
 *
 * `/design detect [paths…] [--rules a,b] [--json]` runs the design detector
 * over the workspace's UI files (or the given files/directories) with the
 * workspace's `design.md` tokens and suppressions, and prints findings grouped
 * by file. No model, no network. The routed design vocabulary (critique,
 * audit, polish, …) arrives with the skill in D-B3; this command is the part
 * that runs without one.
 */
import chalk from 'chalk';
import path from 'node:path';
import {
  detectDesign,
  collectDesignFiles,
  readDesignSystemTokens,
  readDesignSuppressions,
  isDesignRuleId,
  DESIGN_RULES,
  type DesignFinding,
} from '@kinqs/brainrouter-core/design';
import { loadConfig, saveConfig, resolveCliKnobs, _resetCliKnobsCache } from '@kinqs/brainrouter-core/config';
import type { CommandContext } from '../_context.js';

export type DesignCommandAction =
  | { action: 'help' }
  | { action: 'rules' }
  | { action: 'hooks'; tier?: 'off' | 'immediate' | 'full' }
  | { action: 'detect'; paths: string[]; rules?: string[]; json?: boolean }
  | { action: 'error'; message: string };

/** Pure argument parser, exported for tests. */
export function parseDesignArgs(args: string[]): DesignCommandAction {
  const sub = (args[0] ?? '').toLowerCase();
  if (!sub || sub === 'help') return { action: 'help' };
  if (sub === 'rules') return { action: 'rules' };
  if (sub === 'hooks' || sub === 'hook') {
    const t = (args[1] ?? 'status').toLowerCase();
    if (t === 'status') return { action: 'hooks' };
    if (t === 'on') return { action: 'hooks', tier: 'full' };
    if (t === 'off' || t === 'immediate' || t === 'full') return { action: 'hooks', tier: t };
    return { action: 'error', message: 'Usage: /design hooks status | on | off | immediate | full' };
  }
  if (sub === 'detect' || sub === 'audit' || sub === 'check') {
    const out: Extract<DesignCommandAction, { action: 'detect' }> = { action: 'detect', paths: [] };
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      if (flag === '--json') { out.json = true; continue; }
      if (flag === '--rules') {
        const value = inline ?? rest[++i] ?? '';
        const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
        const bad = ids.filter((id) => !isDesignRuleId(id));
        if (bad.length) return { action: 'error', message: `Unknown rule${bad.length > 1 ? 's' : ''}: ${bad.join(', ')} — see /design rules` };
        out.rules = ids;
        continue;
      }
      if (flag.startsWith('--')) return { action: 'error', message: `Unknown option ${flag}` };
      out.paths.push(rest[i]);
    }
    return out;
  }
  return { action: 'error', message: `Unknown subcommand "${sub}". Try: /design detect [paths…] [--rules a,b] [--json] · /design rules` };
}

const SEV = { error: chalk.red('error'), warning: chalk.yellow('warn '), info: chalk.gray('info ') } as const;

export async function tryHandleDesignCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  if (command !== '/design') return false;
  const root = agent.workspaceRoot;
  const parsed = parseDesignArgs(args);
  switch (parsed.action) {
    case 'help': printUsage(); return true;
    case 'error': console.log(chalk.red(`\n${parsed.message}\n`)); return true;
    case 'hooks': {
      if (parsed.tier) {
        const fresh = loadConfig() as { cli?: { design?: { hook?: string } } };
        fresh.cli = fresh.cli ?? {}; fresh.cli.design = { ...(fresh.cli.design ?? {}), hook: parsed.tier };
        saveConfig(fresh as never); _resetCliKnobsCache();
      }
      const tier = resolveCliKnobs(loadConfig()).design.hook;
      console.log(`\n${chalk.bold('Design hook')}: ${tier === 'off' ? chalk.gray('off') : chalk.green(tier)} ${chalk.gray(tier === 'off' ? '— nothing runs after edits' : tier === 'immediate' ? '— each UI file a write tool touches is checked (≤ 5 findings into the next turn)' : '— immediate checks plus a turn-end pass over every UI file the turn wrote')}\n  ${chalk.gray('cli.design.hook in config.json · /design hooks on|off|immediate|full')}\n`);
      return true;
    }
    case 'rules': {
      console.log('');
      for (const r of DESIGN_RULES) console.log(`  ${chalk.cyan(r.id.padEnd(26))} ${chalk.gray(r.category.padEnd(14))} ${r.severity.padEnd(8)}${r.advisory ? chalk.gray('advisory ') : '         '} ${r.name}`);
      console.log('');
      return true;
    }
    case 'detect': {
      const tokens = readDesignSystemTokens(root);
      const suppressions = readDesignSuppressions(root);
      const collected = collectDesignFiles(root, parsed.paths);
      if (!collected.files.length) {
        console.log(chalk.yellow(`\nNo UI files found${collected.refused.length ? `: ${collected.refused.map((r) => `${r.path} (${r.reason})`).join(', ')}` : ''}.\n`));
        return true;
      }
      const result = detectDesign(collected.files, { tokens, suppressions, ...(parsed.rules ? { rules: parsed.rules } : {}) });
      if (parsed.json) { console.log(JSON.stringify({ ...result, refused: collected.refused, truncated: collected.truncated }, null, 2)); return true; }
      console.log(`\n${chalk.bold('Design detector')} ${chalk.gray(result.catalogVersion)} · ${result.files} file(s) · ${result.findings.length} finding(s) — ${chalk.red(`${result.errors} errors`)}, ${chalk.yellow(`${result.warnings} warnings`)}${tokens ? chalk.gray(` · tokens from ${tokens.path}`) : chalk.gray(' · no design.md tokens')}`);
      const byFile = new Map<string, DesignFinding[]>();
      for (const f of result.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
      for (const [file, list] of byFile) {
        console.log(`\n  ${chalk.cyan(file)}`);
        for (const f of list) console.log(`    ${SEV[f.severity]} ${chalk.bold(f.rule)}${f.line ? chalk.gray(`:${f.line}`) : ''}${f.snippet ? chalk.gray(` ${f.snippet}`) : ''}  ${f.message}${f.advisory ? chalk.gray(' (advisory)') : ''}`);
      }
      if (result.suppressed.length) console.log(chalk.gray(`\n  suppressed ${result.suppressed.length}: ${result.suppressed.slice(0, 6).map((s) => `${s.rule}@${path.basename(s.file)} — ${s.reason}`).join('; ')}`));
      if (collected.refused.length) console.log(chalk.gray(`  skipped: ${collected.refused.map((r) => `${r.path} (${r.reason})`).join(', ')}`));
      if (collected.truncated) console.log(chalk.yellow('  file limit reached — narrow the paths to scan the rest'));
      console.log('');
      return true;
    }
  }
}

function printUsage(): void {
  console.log(`
${chalk.bold('/design')} — deterministic design checks (${chalk.gray('no model; design.md tokens + .brainrouter/design-detector.json honoured')})

  /design detect [paths…] [--rules a,b] [--json]   run the rule catalogue over UI files (default: the workspace)
  /design rules                                    list every rule with category and severity
  /design hooks [status|on|off|immediate|full]     the design hook: findings for files you write reach the next turn (cli.design.hook)
`);
}
