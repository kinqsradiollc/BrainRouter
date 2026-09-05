/**
 * DESIGN (ADR-056 D-B1/D-B4) — `/design` slash command, both halves.
 *
 * `/design detect [paths…] [--rules a,b] [--json]` runs the design detector
 * over the workspace's UI files (or the given files/directories) with the
 * workspace's `design.md` tokens and suppressions, and prints findings grouped
 * by file. No model, no network.
 *
 * `/design <verb> [targets…] [--mode m] [--world id]` is the routed
 * vocabulary: the verb becomes a bounded agent turn that runs the one design
 * skill with the verb's playbook named, through the same skill runner every
 * slash-mapped skill uses. `/design verbs` lists them.
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
  DESIGN_SKILL_ID,
  DESIGN_VERBS,
  DESIGN_MODES,
  DESIGN_WORLD_IDS,
  BROWSER_ENGINE_UNAVAILABLE,
  isDesignVerb,
  isDesignMode,
  designVerbPrompt,
  runDesignCritique,
  type DesignVerbId,
  type DesignModeId,
} from '@kinqs/brainrouter-core/design';
import { loadConfig, saveConfig, resolveCliKnobs, _resetCliKnobsCache } from '@kinqs/brainrouter-core/config';
import type { CommandContext } from '../_context.js';
import { runSkillByName } from '../_helpers.js';
import { createEphemeralSideAgent } from '../session/ephemeralSideAgent.js';

export type DesignCommandAction =
  | { action: 'help' }
  | { action: 'rules' }
  | { action: 'hooks'; tier?: 'off' | 'immediate' | 'full' }
  | { action: 'verbs' }
  | { action: 'verb'; verb: DesignVerbId; targets: string[]; mode?: DesignModeId; world?: string }
  | { action: 'detect'; paths: string[]; rules?: string[]; json?: boolean; browser?: boolean }
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
  if (sub === 'verbs') return { action: 'verbs' };
  if (isDesignVerb(sub)) {
    const out: Extract<DesignCommandAction, { action: 'verb' }> = { action: 'verb', verb: sub, targets: [] };
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      if (flag === '--mode') {
        const value = (inline ?? rest[++i] ?? '').toLowerCase();
        if (!isDesignMode(value)) return { action: 'error', message: `Unknown mode "${value}". Modes: ${DESIGN_MODES.map((m) => m.id).join(' | ')}` };
        out.mode = value;
        continue;
      }
      if (flag === '--world') {
        const value = (inline ?? rest[++i] ?? '').toLowerCase();
        if (!DESIGN_WORLD_IDS.includes(value)) return { action: 'error', message: `Unknown world "${value}". Worlds: ${DESIGN_WORLD_IDS.join(' | ')}` };
        out.world = value;
        continue;
      }
      if (flag.startsWith('--')) return { action: 'error', message: `Unknown option ${flag}` };
      out.targets.push(rest[i]);
    }
    return out;
  }
  if (sub === 'detect' || sub === 'check') {
    const out: Extract<DesignCommandAction, { action: 'detect' }> = { action: 'detect', paths: [] };
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const [flag, inline] = rest[i].split('=', 2);
      if (flag === '--json') { out.json = true; continue; }
      if (flag === '--browser') { out.browser = true; continue; }
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
  return { action: 'error', message: `Unknown subcommand "${sub}". Try: /design <verb> [targets…] (see /design verbs) · /design detect [paths…] [--rules a,b] [--json] · /design rules` };
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
    case 'verbs': {
      console.log(`\n${chalk.bold('/design <verb>')} ${chalk.gray(`— routed to the ${DESIGN_SKILL_ID} skill; add --mode ${DESIGN_MODES.map((m) => m.id).join('|')} and --world <id>`)}\n`);
      for (const v of DESIGN_VERBS) console.log(`  ${chalk.cyan(v.id.padEnd(10))} ${v.edits ? chalk.yellow('edits ') : chalk.gray('report')}  ${v.summary}`);
      console.log('');
      return true;
    }
    case 'verb': {
      if (parsed.verb === 'critique') {
        // ADR-056 D-B4 — two assessments that cannot see each other. The design
        // review runs in an isolated, ephemeral side agent (the /side seam); the
        // detector evidence pass runs only after it ends; synthesis gets both.
        const seam = {
          run: async (prompt: string): Promise<string> => {
            const side = createEphemeralSideAgent(agent, `${agent.sessionKey ?? 'design'}:critique:${Date.now()}`);
            await ctx.repl.runAgentTurnAsync(prompt, { agent: side, ephemeral: true });
            const last = [...side.chatHistory].reverse().find((m: any) => m?.role === 'assistant' && typeof m.content === 'string');
            return typeof last?.content === 'string' ? last.content : '';
          },
        };
        const run = await runDesignCritique({ workspaceRoot: root, targets: parsed.targets, ...(parsed.mode ? { mode: parsed.mode } : {}), seam });
        if (run.degraded) console.log(chalk.yellow(`\n${run.synthesisPrompt.split('\n')[0]}`));
        console.log(chalk.gray(`  evidence: ${run.evidence.files} file(s), ${run.evidence.errors} errors, ${run.evidence.warnings} warnings · snapshot ${run.snapshotPath}${run.trend ? `\n  ${run.trend}` : ''}\n`));
        await runSkillByName(agent, ctx.mcpClient, DESIGN_SKILL_ID, run.synthesisPrompt, undefined, (p) => ctx.repl.runAgentTurn(p));
        return true;
      }
      const prompt = designVerbPrompt({ verb: parsed.verb, targets: parsed.targets, ...(parsed.mode ? { mode: parsed.mode } : {}), ...(parsed.world ? { world: parsed.world } : {}) });
      await runSkillByName(agent, ctx.mcpClient, DESIGN_SKILL_ID, prompt, undefined, (p) => ctx.repl.runAgentTurn(p));
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
      // ADR-056 D-B1 — the CLI has no in-app browser; it says so rather than pretend.
      if (parsed.browser) console.log(chalk.yellow(`  ${BROWSER_ENGINE_UNAVAILABLE}`));
      console.log('');
      return true;
    }
  }
}

function printUsage(): void {
  console.log(`
${chalk.bold('/design')} — design as verbs, and the deterministic checks behind them

  /design <verb> [targets…] [--mode m] [--world id]  run one verb of the design skill: critique · audit · polish · harden · typeset · layout · … (/design verbs)
  /design verbs                                    list every verb with what it edits
  /design detect [paths…] [--rules a,b] [--json] [--browser]   run the rule catalogue over UI files (default: the workspace); --browser = computed-style engine (desktop only — the CLI says so)
  /design rules                                    list every rule with category and severity
  /design hooks [status|on|off|immediate|full]     the design hook: findings for files you write reach the next turn (cli.design.hook)
`);
}
