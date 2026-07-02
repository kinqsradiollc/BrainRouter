/**
 * Spawn / lifecycle slash commands — `/bg`, `/build`, `/spawn`, `/wait`,
 * `/kill`. Start detached workers, run the build loop, delegate child
 * agents, wait on them, and kill running ones. Extracted verbatim from the
 * former orchestration/index.ts switch.
 */

import chalk from 'chalk';
import { listRoles, getSession } from '@kinqs/brainrouter-core/orchestration';
import type { CommandContext } from '../_context.js';

export async function handleBg(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  // CLI-4 — run a prompt as a detached background worker. Reuses the proven
  // worker-thread infra (separate Agent, on-disk transcript) — no
  // foreground turn-state hazard. Manage with /workers or /ps.
  const prompt = args.join(' ').trim();
  if (!prompt) {
    console.log(chalk.red('\nUsage: /bg <prompt> — run a prompt in a detached background worker.'));
    console.log(chalk.gray('  Then: /workers attach <id> to view · /workers close <id> to stop · /ps to list.\n'));
    return true;
  }
  try {
    const w = agent.spawnBackgroundWorker(prompt);
    console.log(chalk.green(`\n✓ Detached background worker ${chalk.cyan(w.id)} started.`));
    console.log(chalk.gray(`  View: /workers attach ${w.id}  ·  Stop: /workers close ${w.id}  ·  All: /ps\n`));
  } catch (err: any) {
    console.log(chalk.red(`\nFailed to start background worker: ${err?.message ?? err}\n`));
  }
  return true;
}

export async function handleBuild(ctx: CommandContext): Promise<boolean> {
  const { args } = ctx;
  // BUILD-LOOP (0.4.12 P1) — run the plan → implement → verify → review loop
  // for one task via the `build` workflow template. Single-agent stays the
  // default; this is the explicit opt-in trigger.
  const task = args.join(' ').trim();
  if (!task) {
    console.log(chalk.red('\nUsage: /build <task>\n'));
    console.log(chalk.gray('  Runs a plan → implement → verify → review loop. The worker implements in an isolated worktree (merged back on clean completion).\n'));
    return true;
  }
  ctx.repl.runAgentTurn(
    `Run the build loop for this task using the run_workflow tool with template "build" and templateArgs ${JSON.stringify({ task })}. ` +
    `It runs four phases — plan (architect) → implement (worker) → verify (verifier) → review (reviewer). ` +
    `When it finishes, report: what changed, the verify PASS/FAIL, and the review verdict.`,
  );
  return true;
}

export async function handleSpawn(ctx: CommandContext): Promise<boolean> {
  const { args } = ctx;
  const role = args[0];
  const prompt = args.slice(1).join(' ').trim();
  if (!role || !prompt) {
    console.log(chalk.red('\nUsage: /spawn <role> <prompt>\n'));
    return true;
  }
  // Validate the role upfront — saves an LLM round-trip that would just
  // error out server-side anyway.
  const validRoles = listRoles().map((r) => r.name);
  if (!validRoles.includes(role)) {
    console.log(chalk.red(`\nUnknown role "${role}". Available: ${validRoles.join(', ')}.\n`));
    return true;
  }
  ctx.repl.runAgentTurn(
    `Use the delegate_agent tool to start a ${role} child agent (background) with this prompt:\n\n${prompt}\n\nReturn the child agent id when done. If you need the result immediately, use task_agent instead.`,
  );
  return true;
}

export async function handleWait(ctx: CommandContext): Promise<boolean> {
  const { args } = ctx;
  const id = args[0];
  const ms = args[1] ? Number(args[1]) : 120000;
  if (!id) { console.log(chalk.red('\nUsage: /wait <id> [timeoutMs]\n')); return false; }
  ctx.repl.runAgentTurn(
    `Use the wait_agent tool with id="${id}" and timeoutMs=${ms}. Then summarize the child output for me.`,
  );
  return true;
}

export async function handleKill(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  const id = args[0];
  if (!id) { console.log(chalk.red('\nUsage: /kill <agent-id>\n')); return false; }
  const session = getSession(agent.workspaceRoot, id);
  if (!session) { console.log(chalk.red(`\nNo agent session with id "${id}".\n`)); return false; }
  if (session.status !== 'pending' && session.status !== 'running') {
    console.log(chalk.gray(`\nAgent ${id} is already ${session.status}.\n`));
    return true;
  }
  ctx.repl.runAgentTurn(
    `Use the close_agent tool with id="${id}" and reason="user-requested kill". Then confirm the close result.`,
  );
  return true;
}
