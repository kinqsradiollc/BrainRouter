// ADR-041 D14 (glass box, commitment #1) — the CLI text projection of the
// request-header ledger. `/inspect [n]` prints the last n LLM request headers for
// this session (model, effort, message/tool counts, and a bounded excerpt of the
// rendered system prompt) — what the model actually saw — captured only when
// `cli.traceRequests` is on.

import chalk from 'chalk';
import { readRequestTrace } from '@kinqs/brainrouter-core/session';
import type { CommandContext } from '../_context.js';

export async function tryHandleInspectCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/inspect') return false;
  const { agent, args } = ctx;

  const parsed = Number.parseInt(args[0] ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  const records = readRequestTrace(agent.workspaceRoot, agent.sessionKey, limit);

  if (records.length === 0) {
    console.log(chalk.yellow(
      '\nNo request trace captured yet. Turn it on with `"cli": { "traceRequests": true }` in ' +
      '~/.config/brainrouter/config.json, then run a turn.\n',
    ));
    return true;
  }

  console.log(chalk.bold(`\nLast ${records.length} request header(s) — what the model saw:\n`));
  for (const r of records) {
    const head = `${r.at}  ${r.model}${r.effort ? ` · effort=${r.effort}` : ''}`;
    console.log(chalk.cyan(`  ${head}`));
    console.log(`    ${r.messageCount} messages · system ${r.systemChars} chars · ${r.toolNames.length} tools`);
    if (r.toolNames.length > 0) console.log(chalk.dim(`    tools: ${r.toolNames.join(', ')}`));
    const oneLine = r.systemExcerpt.replace(/\s+/g, ' ').trim();
    console.log(chalk.dim(`    system: ${oneLine.slice(0, 200)}${oneLine.length > 200 ? '…' : ''}`));
    console.log('');
  }
  return true;
}
