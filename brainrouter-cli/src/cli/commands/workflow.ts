/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import { marked } from 'marked';
import { LOCAL_TOOLS } from '../../agent/agent.js';
import { callMcpTool } from '../../runtime/mcpUtils.js';
import { listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, listWorkflows, readArtifact, setCurrentWorkflow, slugify, updateWorkflowStatus, workflowExists } from '../../state/workflowArtifacts.js';
import { clearGoal, completeGoal, editGoal, formatBudget, GoalConflictError, type GoalStatus, GoalTooLongError, GOAL_TEXT_MAX_CHARS, pauseGoal, readGoal, resumeGoal, setGoal, setGoalBudget, setGoalTokenBudget, type Goal } from '../../state/goalStore.js';
import { askYesNo } from '../cliPrompt.js';
import { formatPlan, readPlan, updatePlan } from '../../state/taskStore.js';
import { getLoopState, parseInterval, startLoop, stopLoop } from '../../runtime/loopRunner.js';
import type { CommandContext } from './_context.js';
import { SLASH_TO_SKILL } from '../../prompt/skillRunner.js';
import { buildGoalKickoffPrompt, runSkillByName, runSkillCommand } from './_helpers.js';

// Promise-flavored exec for case bodies that shell out.
const execPromise = promisify(exec);

/**
 * Decide whether `/grill-me` should refuse to fire because the current
 * workflow already has a written `spec.md`. The clarifying pass is meant to
 * happen BEFORE the spec is committed — once a spec exists, asking again
 * usually means we're re-litigating answers the user already gave, which
 * wastes a turn. `--force` is the explicit escape hatch when the user
 * genuinely wants a second clarifying pass (e.g., scope has drifted).
 *
 * Exported helper for unit tests so the guard logic can be exercised
 * without standing up the whole REPL context. NOT pure: reads workflow
 * state from disk (`getCurrentWorkflow`, `readArtifact`) and the latter
 * may mkdirSync the workflow folder as a side effect.
 */
export function shouldSkipGrillMe(
  workspaceRoot: string,
  force: boolean,
  sessionKey?: string,
): { skip: boolean; slug?: string; specPath?: string } {
  if (force) return { skip: false };
  // 9d-bugfix: scope the "is there an active workflow?" check to THIS
  // session, not the workspace pointer. A fresh CLI with no session
  // binding should not be told "plan already exists" just because a
  // previous CLI ran `/spec` here.
  const slug = getCurrentWorkflow(workspaceRoot, sessionKey);
  if (!slug) return { skip: false };
  const spec = readArtifact(workspaceRoot, slug, ARTIFACT.spec);
  if (!spec) return { skip: false };
  return {
    skip: true,
    slug,
    specPath: artifactRelativePath(workspaceRoot, slug, ARTIFACT.spec),
  };
}

/**
 * Strip a `--force` token from a slash command's arg list, returning the
 * flag's presence plus the rest. Used by /feature-dev / /spec / /review
 * to gate Subtask 6's clobber prompt (mirrors /grill-me's --force parsing).
 */
function parseForceFlag(args: string[]): { force: boolean; rest: string[] } {
  return { force: args.includes('--force'), rest: args.filter((a) => a !== '--force') };
}

/**
 * Print the one-line confirmation banner after a successful `/workflow
 * switch <slug>` (or a no-op switch onto the already-current workflow).
 * Format: `Switched to workflow <slug> — goal: <status>, iteration N of cap`
 * — or `goal: —` when no goal is bound.
 */
function printWorkflowSwitchConfirmation(slug: string, goal: Goal | null): void {
  if (!goal) {
    console.log(chalk.green(`\n✓ Switched to workflow "${slug}" — goal: —.\n`));
    return;
  }
  const statusLabel = goal.status.replace('_', ' ');
  const iter = goal.budget.iterationsUsed;
  const cap = formatBudget(goal.budget.maxIterations);
  console.log(chalk.green(
    `\n✓ Switched to workflow "${slug}" — goal: ${statusLabel}, iteration ${iter} of ${cap}.\n`,
  ));
}

export async function tryHandleWorkflowCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/skills':
    {
      const spinner = makeSpinner(chalk.gray('Fetching skills...')).start();
      try {
        const res = await callMcpTool<any[]>(mcpClient, 'list_skills', { scope: 'all' });
        spinner.stop();
        if (!res.isError && Array.isArray(res.parsed)) {
          const skillsList = res.parsed;
          console.log(chalk.bold('\n🧠 BrainRouter Skills:'));
          if (skillsList.length > 0) {
            for (const skill of skillsList) {
              console.log(`  • ${chalk.cyan(skill.name)} (${chalk.gray(skill.scope)}) - ${skill.description}`);
            }
          } else {
            console.log(chalk.yellow('  No skills found.'));
          }
        } else {
          console.log(chalk.red('\nFailed to parse skills list response.'));
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to list skills.'));
        console.error(chalk.red(`  Error: ${err.message}`));
      }
      console.log();
      return true;
    }
    case '/tools':
    {
      console.log(chalk.bold('\nLocal Workspace Tools:'));
      for (const tool of LOCAL_TOOLS) {
        console.log(`  ${chalk.cyan(tool.name)} - ${tool.description}`);
      }

      const spinner = makeSpinner(chalk.gray('Fetching MCP tools...')).start();
      try {
        const res = await mcpClient.listTools();
        spinner.stop();
        const tools = res.tools || [];
        console.log(chalk.bold('\nMCP Tools:'));
        if (tools.length === 0) {
          console.log(chalk.yellow('  No MCP tools exposed by the active server.'));
        } else {
          for (const tool of tools) {
            console.log(`  ${chalk.cyan(tool.name)} - ${tool.description || 'No description'}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to list MCP tools.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }
      console.log();
      return true;
    }
    case '/plan':
    {
      // `/plan clear` is the explicit escape hatch when stale items from a
      // prior workflow are blocking goal_complete (the plan-honesty guard
      // refuses to complete with open items). `/goal <text>` also
      // auto-clears, but this lets the user reset without setting a new
      // goal — useful mid-session if you just abandoned a workflow.
      if (args[0] === 'clear') {
        const before = readPlan(agent.workspaceRoot, agent.sessionKey);
        const pendingCount = before.items.filter((i) => i.status !== 'completed').length;
        updatePlan(
          agent.workspaceRoot,
          { plan: [], explanation: 'cleared by /plan clear' },
          agent.sessionKey,
        );
        console.log(chalk.green(`\n✓ Plan cleared.`));
        if (pendingCount > 0) {
          console.log(chalk.gray(`  Removed ${pendingCount} pending item${pendingCount === 1 ? '' : 's'}.\n`));
        } else {
          console.log();
        }
        return true;
      }
      const state = readPlan(agent.workspaceRoot, agent.sessionKey);
      console.log(chalk.bold('\nPlan:'));
      console.log(chalk.gray(formatPlan(state)));
      if (state.updatedAt) {
        console.log(chalk.gray(`Updated: ${state.updatedAt}`));
      }
      console.log(chalk.gray('\nSubcommands: /plan | /plan clear\n'));
      return true;
    }
    case '/diff':
    {
      // Stream the diff instead of buffering. The old execPromise approach
      // read the whole diff into memory, then colored every line in a JS
      // loop before any output appeared — for a 5k-line diff that took
      // seconds and you saw nothing until completion. Now: spawn `git diff
      // --color=always` and pipe stdout directly so output appears as it
      // streams.
      const stagedFlag = args.includes('--staged') || args.includes('--cached');
      const allFlag = args.includes('--all') || args.includes('HEAD');
      const gitArgs = ['diff', '--color=always'];
      if (allFlag) gitArgs.push('HEAD');
      else if (stagedFlag) gitArgs.push('--cached');
      console.log(chalk.bold(
        `\n--- Git Diff (${allFlag ? 'staged + unstaged' : stagedFlag ? 'staged' : 'unstaged'}) ---`,
      ));
      await new Promise<void>((resolve) => {
        const child = spawn('git', gitArgs, {
          cwd: agent.workspaceRoot,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.on('exit', (code) => {
          if (code !== 0 && code !== null && code !== 1) {
            // git diff returns 1 when there are differences with --exit-code;
            // without that flag it's just success. Anything else is an error.
            console.log(chalk.yellow(`(git diff exited ${code})`));
          }
          resolve();
        });
        child.on('error', (err) => {
          console.log(chalk.red(`Failed to spawn git: ${err.message}`));
          resolve();
        });
      });
      // If the diff was empty, git printed nothing — give the user a hint.
      // (We can't detect empty without buffering; just always print the tip.)
      console.log(chalk.gray('  Tip: /diff --staged for staged changes only, /diff --all (or HEAD) for both.\n'));
      return true;
    }
    case '/commit':
    {
      // Pre-check git status so we can skip an LLM round-trip when there's
      // nothing to commit. The actual commit work goes through ctx.repl.runAgentTurn
      // so it inherits the normal pipeline: isProcessing locking, goal
      // continuation, /raw honoring, contradiction surfacing, token summary.
      const spinner = makeSpinner(chalk.gray('Checking git status...')).start();
      let statusOut = '';
      let diffOut = '';
      try {
        ({ stdout: statusOut } = await execPromise('git status --short'));
        if (!statusOut.trim()) {
          spinner.succeed(chalk.green('Working directory clean. Nothing to commit.'));
          return true;
        }
        spinner.text = chalk.gray('Reading diff...');
        ({ stdout: diffOut } = await execPromise('git diff HEAD'));
        spinner.stop();
      } catch (err: any) {
        spinner.fail(chalk.red(`Failed to read git status: ${err.message}`));
        return true;
      }
      console.log(chalk.bold('\nGit changes detected:'));
      console.log(chalk.gray(statusOut));
      const prompt =
        `Based on the following git status and git diff, please create a commit. ` +
        `Stage the modified/untracked files (using git add) and run git commit with an appropriate conventional commit message.\n\n` +
        `Git status:\n${statusOut}\n\nDiff:\n${diffOut}`;
      ctx.repl.runAgentTurn(prompt);
      return true;
    }
    case '/feature-dev':
    {
      // `--force` accepted but ignored — workflows no longer carry goals,
      // so there's nothing to "clobber" when starting a new one. Kept on
      // the CLI for back-compat with any user muscle memory / scripts.
      const parsed = parseForceFlag(args);
      const feature = parsed.rest.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /feature-dev <feature description>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'feature-dev', sessionKey: agent.sessionKey });
      const specPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.spec);
      const tasksPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.tasks);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(specPath)}`));
      try {
        updatePlan(agent.workspaceRoot, {
          explanation: `Feature: ${feature}`,
          plan: [
            { step: 'Discovery: clarify scope and constraints', status: 'in_progress' },
            { step: 'Exploration: map relevant code with explorer agents', status: 'pending' },
            { step: 'Architecture: choose design via architect agent', status: 'pending' },
            { step: `Write spec.md to ${specPath}`, status: 'pending' },
            { step: `Write tasks.md to ${tasksPath}`, status: 'pending' },
            { step: 'Implementation: worker agent edits code', status: 'pending' },
            { step: 'Review: reviewer agent inspects diff', status: 'pending' },
            { step: 'Verify: verifier agent runs tests', status: 'pending' },
          ],
        }, agent.sessionKey);
      } catch (err: any) {
        console.log(chalk.yellow(`Plan setup warning: ${err.message}`));
      }
      await runSkillCommand(agent, mcpClient, command, feature, [
        '## Required memory-first opening',
        'Run `memory_search` with the feature name AND `memory_graph_query` to surface prior knowledge in this workspace. Pass any recovered record IDs to children via `spawn_agent`\'s `seedRecordIds`.',
        '',
        '## Workflow (mandatory, no shortcuts)',
        `Workflow slug: \`${meta.slug}\`. Folder: \`${path.dirname(specPath)}\`.`,
        '',
        'Phase 1 — Exploration: call `spawn_agent` AT LEAST TWICE in parallel with role=explorer. Different children must cover different parts of the codebase relevant to this feature. Do not narrate exploration yourself; use the tool.',
        '',
        'Phase 2 — Architecture: after explorers complete (use `wait_agent`), call `spawn_agent` with role=architect to produce ≥2 design alternatives and a recommended slice.',
        '',
        `Phase 3 — Persist artifacts: call \`write_file\` to create \`${specPath}\` (the spec) AND \`${tasksPath}\` (the task breakdown). Use the spec-driven-skill structure for \`spec.md\` and the planning-skill structure for \`tasks.md\`. These files are the canonical record — do NOT produce a chat-only plan.`,
        '',
        'Phase 4 — STOP: present a short summary in chat referencing the file paths, then explicitly ask the user to confirm before any `worker` implementation begins.',
      ].join('\n'), ctx.repl.runAgentTurn);
      return true;
    }
    case '/grill-me':
    {
      // `/grill-me` doesn't render its own picker — it just nudges the model
      // (via the CLARIFY-mode overlay in systemPrompt.ts) to ask 2–5
      // questions back instead of jumping to implementation tools. The
      // picker UI lives in cliPrompt.ts and stays untouched.
      const force = args.includes('--force');
      const task = args.filter((a) => a !== '--force').join(' ').trim();
      if (!task) {
        console.log(chalk.red('\nUsage: /grill-me [--force] <task description>\n'));
        return true;
      }
      const decision = shouldSkipGrillMe(agent.workspaceRoot, force, agent.sessionKey);
      if (decision.skip) {
        console.log(chalk.yellow(`\nPlan already exists at ${chalk.cyan(decision.specPath)}.`));
        console.log(chalk.gray(
          `  Drop into it with \`/workflow switch ${decision.slug}\`, or use \`/grill-me --force\` to clarify additional details.\n`,
        ));
        return true;
      }
      // Latch activeSkill BEFORE refreshing the system prompt so the
      // CLARIFY overlay lands in chatHistory[0]. The post-turn hook in
      // repl.ts clears activeSkill + refreshes again, so the overlay
      // doesn't bleed into the user's next plain prompt.
      agent.activeSkill = 'grill-me';
      agent.refreshSystemPrompt();
      const prompt = [
        '[CLARIFY — grill-me]',
        '',
        `The user wants help with: ${task}`,
        '',
        'Before doing anything, ask 2–5 short questions back to disambiguate scope, format, and unstated assumptions. Use `ask_user_choice` for mutually-exclusive options; plain prose for free-form input. End with a one-paragraph "what I\'ll do once you answer" so the user can sanity-check your read of the request.',
      ].join('\n');
      ctx.repl.runAgentTurn(prompt);
      return true;
    }
    case '/spec':
    {
      // `--force` accepted but ignored — see /feature-dev for rationale.
      const parsed = parseForceFlag(args);
      const feature = parsed.rest.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /spec <feature title>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'spec', sessionKey: agent.sessionKey });
      const specPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.spec);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(specPath)}`));
      await runSkillCommand(agent, mcpClient, '/spec', feature, [
        '## Goal',
        `Produce a complete specification for: "${feature}".`,
        '',
        '## Mandatory steps',
        '1. Open with `memory_search` for related prior work; cite any recovered record IDs in the spec.',
        '2. Optionally spawn 1–2 `explorer` children to confirm scope before drafting (only if the feature touches unfamiliar code).',
        `3. Call \`write_file\` with path \`${specPath}\` containing the full spec, structured per the spec-driven-skill template (Objective, Commands, Project Structure, Code Style, Testing Strategy, Boundaries).`,
        '4. In chat, summarize the spec in ≤ 10 lines and reference the file path. Ask the user to approve before generating tasks or implementation.',
        '',
        '## Anti-patterns',
        '- Do NOT produce a multi-section spec inline in chat without writing the file.',
        '- Do NOT proceed to task breakdown or implementation until the user explicitly approves.',
      ].join('\n'), ctx.repl.runAgentTurn);
      return true;
    }
    case '/review':
    {
      // `--force` accepted but ignored — see /feature-dev for rationale.
      const parsed = parseForceFlag(args);
      const scope = parsed.rest.join(' ').trim() || 'current unstaged and staged changes (git diff HEAD)';
      const reviewTitle = `Review: ${scope}`;
      const meta = createWorkflow(agent.workspaceRoot, { title: reviewTitle, kind: 'review', sessionKey: agent.sessionKey });
      const reportPath = artifactRelativePath(agent.workspaceRoot, meta.slug, 'review.md');
      console.log(chalk.gray(`Workflow folder: ${path.dirname(reportPath)}`));
      await runSkillCommand(agent, mcpClient, command, scope, [
        '## Required memory-first opening',
        'Run `memory_search` for similar past reviews and `memory_file_history` for any files touched by this diff. Pass relevant record IDs through `seedRecordIds`.',
        '',
        '## Workflow (mandatory)',
        `Workflow slug: \`${meta.slug}\`. Output file: \`${reportPath}\`.`,
        '',
        'Step 1: call `spawn_agent` THREE times in parallel with role=reviewer and access=read. Focuses:',
        '(a) correctness / bugs / security;',
        '(b) maintainability / readability / design;',
        '(c) conventions / tests / documentation.',
        'Step 2: `wait_agent` on all three.',
        `Step 3: \`write_file\` to \`${reportPath}\` containing a severity-ordered synthesis (blocker / major / minor / nit) with file:line citations.`,
        'Step 4: summarize ≤ 15 lines in chat referencing the file. Do NOT edit reviewed files.',
      ].join('\n'), ctx.repl.runAgentTurn);
      return true;
    }
    case '/implement-plan':
    {
      const plan = readPlan(agent.workspaceRoot, agent.sessionKey);
      const next = plan.items.find(i => i.status === 'pending' || i.status === 'in_progress');
      if (!next) { console.log(chalk.yellow('\nNo pending plan items.\n')); break; }
      // Attach this execution turn to the current workflow if there is one, so
      // walkthrough.md accumulates per workflow rather than per CLI session.
      const currentSlug = getCurrentWorkflow(agent.workspaceRoot, agent.sessionKey);
      const slug = currentSlug ?? createWorkflow(agent.workspaceRoot, { title: next.step, kind: 'implement-plan', sessionKey: agent.sessionKey }).slug;
      const walkPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.walkthrough);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(walkPath)}`));
      await runSkillCommand(agent, mcpClient, command, `Next plan item: "${next.step}"`, [
        '## Required memory-first opening',
        'Run `memory_search` and `memory_task_state` scoped to this plan item. Seed the `worker` child with the record IDs.',
        '',
        '## Workflow (mandatory)',
        `Workflow slug: \`${slug}\`. Walkthrough file: \`${walkPath}\`.`,
        '',
        'Step 1: `update_plan` to mark this item `in_progress`.',
        'Step 2: `spawn_agent` role=worker access=write with concrete acceptance criteria AND `seedRecordIds`.',
        'Step 3: after the worker completes, `spawn_agent` role=verifier access=shell to run tests/typechecks.',
        `Step 4: append a section to \`${walkPath}\` (use \`read_file\` then \`write_file\`) recording: item name, files changed, verification commands run, PASS/FAIL, follow-ups.`,
        'Step 5: only on PASS, `update_plan` to `completed` AND `memory_task_update` with outcome. On FAIL, keep `in_progress`, surface failing output, `memory_task_update` with blocker.',
      ].join('\n'), ctx.repl.runAgentTurn);
      return true;
    }
    case '/approve':
    {
      const slug = args[0] || getCurrentWorkflow(agent.workspaceRoot, agent.sessionKey);
      if (!slug) {
        console.log(chalk.red('\nNo current workflow. Use /spec or /feature-dev first, or /approve <slug>.\n'));
        return true;
      }
      const spec = readArtifact(agent.workspaceRoot, slug, ARTIFACT.spec);
      if (!spec) {
        console.log(chalk.red(`\nWorkflow "${slug}" has no spec.md yet. Run /spec or /feature-dev first.\n`));
        return true;
      }
      const next = updateWorkflowStatus(agent.workspaceRoot, slug, 'in-progress');
      if (!next) {
        console.log(chalk.red(`\nWorkflow "${slug}" not found.\n`));
        return true;
      }
      console.log(chalk.green(`\n✓ Approved workflow "${slug}". Status: in-progress.`));
      console.log(chalk.gray('Kicking off implementation phase…\n'));
      const tasksPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.tasks);
      const walkPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.walkthrough);
      ctx.repl.runAgentTurn(
        `The user just approved workflow \`${slug}\`. Begin implementation now.\n\n` +
        `1. If \`${tasksPath}\` does not exist yet, read \`${artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.spec)}\` and \`write_file\` a complete tasks.md (vertical slices, S/M-sized, with acceptance criteria) before doing anything else.\n` +
        `2. Pick the first pending task from tasks.md and call \`update_plan\` to mark it in_progress.\n` +
        `3. \`spawn_agent\` role=worker access=write to implement it. Pass any relevant recalled record IDs via seedRecordIds.\n` +
        `4. After the worker completes, \`spawn_agent\` role=verifier access=shell to run tests/typechecks.\n` +
        `5. Append a section to \`${walkPath}\` (read+write) recording the outcome.\n` +
        `6. STOP after the first task and ask whether to continue. Do not silently work through every task — the user approves slices, not the whole batch.`,
      );
      return true;
    }
    case '/workflow':
    {
      // Subcommands: switch <slug> | pause | resume <slug>
      // The plural `/workflows` (next case) is the list command. Singular
      // `/workflow` carries actions on the current pointer / a named slug.
      const sub = (args[0] ?? '').toLowerCase();
      if (!sub) {
        console.log(chalk.red('\nUsage: /workflow switch <slug> | pause | resume <slug>\n'));
        return true;
      }
      if (sub === 'switch') {
        const rawSlug = (args[1] ?? '').trim();
        if (!rawSlug) {
          console.log(chalk.red('\nUsage: /workflow switch <slug>\n'));
          console.log(chalk.gray('  See /workflows for available slugs.\n'));
          return true;
        }
        // Canonicalize at the entry point. Without this, a user typing
        // `/workflow switch My Workflow` (or any title-cased / spaced
        // variant) would have the raw string written verbatim into the
        // pointer file by setCurrentWorkflow, breaking `w.slug ===
        // currentSlug` matching everywhere downstream (the ★ marker
        // on /workflows, the "already on it" no-op below, etc.).
        const targetSlug = slugify(rawSlug);
        if (!workflowExists(agent.workspaceRoot, targetSlug)) {
          console.log(chalk.red(`\nNo such workflow: "${rawSlug}".`));
          console.log(chalk.gray('  Use /workflows to see what exists, or /spec / /feature-dev to create a new one.\n'));
          return true;
        }
        if (getCurrentWorkflow(agent.workspaceRoot, agent.sessionKey) === targetSlug) {
          // Already on it — print the same banner as if we'd switched so
          // the user gets a consistent confirmation instead of "no-op".
          const g = readGoal(agent.workspaceRoot, agent.sessionKey);
          printWorkflowSwitchConfirmation(targetSlug, g);
          return true;
        }
        // Post-decoupling (`/workflow switch` is now pure navigation):
        // - Updates the session-scoped workflow pointer so subsequent
        //   `/spec` / `/feature-dev` / `/implement-plan` calls in THIS
        //   session land artifacts under <targetSlug>'s folder.
        // - Does NOT touch the session's goal. Goal is session-scoped
        //   runtime state, workflows are durable storage — see
        //   goalStore.ts:resolveGoalScope for the design rationale.
        // - Earlier migration / conflict prompt (planWorkflowSwitch +
        //   migrateSessionGoalToWorkflow + applyMigrationResolution) is
        //   gone with the workflow-goal storage that motivated it.
        setCurrentWorkflow(agent.workspaceRoot, targetSlug, agent.sessionKey);
        agent.refreshSystemPrompt();
        const sessionGoal = readGoal(agent.workspaceRoot, agent.sessionKey);
        printWorkflowSwitchConfirmation(targetSlug, sessionGoal);
        return true;
      }
      if (sub === 'pause') {
        // `/workflow pause` is now an alias for `/goal pause` — workflows
        // don't carry their own goal anymore, so "pause the workflow's
        // goal" is just "pause the session's goal" which is what
        // pauseGoal already does.
        const g = pauseGoal(agent.workspaceRoot, agent.sessionKey);
        if (!g) {
          console.log(chalk.yellow('\nNo active goal to pause. Use /goal <text> to set one.\n'));
          return true;
        }
        agent.refreshSystemPrompt();
        const titlePreview = g.text.length > 60 ? g.text.slice(0, 60) + '…' : g.text;
        const slug = getCurrentWorkflow(agent.workspaceRoot, agent.sessionKey);
        const wfLabel = slug ? ` (in workflow "${slug}")` : '';
        console.log(chalk.yellow(`\n⏸  Paused goal${wfLabel}: ${titlePreview}.`));
        console.log(chalk.gray('    /goal resume  to continue this goal later.\n'));
        return true;
      }
      if (sub === 'resume') {
        const rawSlug = (args[1] ?? '').trim();
        if (!rawSlug) {
          console.log(chalk.red('\nUsage: /workflow resume <slug>\n'));
          return true;
        }
        // Canonicalize for the same reason as /workflow switch (see above).
        const targetSlug = slugify(rawSlug);
        if (!workflowExists(agent.workspaceRoot, targetSlug)) {
          console.log(chalk.red(`\nNo such workflow: "${rawSlug}".\n`));
          return true;
        }
        // `/workflow resume <slug>` is now sugar for "switch artifacts
        // to <slug>'s folder, then resume the session's paused goal if
        // there is one." Workflows no longer carry goals; resume is a
        // goal-only operation that just happens to want a workflow set
        // first so artifact writes land in the right place.
        setCurrentWorkflow(agent.workspaceRoot, targetSlug, agent.sessionKey);
        const resumed = resumeGoal(agent.workspaceRoot, agent.sessionKey);
        agent.refreshSystemPrompt();
        if (!resumed) {
          console.log(chalk.green(`\n▶  Switched to workflow "${targetSlug}" — no paused session goal to resume.\n`));
          console.log(chalk.gray(`    Set a fresh /goal here when you're ready.\n`));
          return true;
        }
        console.log(chalk.green(
          `\n▶  Switched to workflow "${targetSlug}" and resumed goal (${resumed.budget.iterationsUsed}/${formatBudget(resumed.budget.maxIterations)} used). Firing next iteration…\n`,
        ));
        ctx.repl.runAgentTurn(buildGoalKickoffPrompt(resumed, 'resume'));
        return true;
      }
      console.log(chalk.red(`\nUnknown /workflow subcommand: "${sub}".`));
      console.log(chalk.gray('  Subcommands: switch <slug> | pause | resume <slug>\n'));
      return true;
    }
    case '/workflows':
    {
      const workflows = listWorkflows(agent.workspaceRoot);
      console.log(chalk.bold('\nDurable Workflows'));
      if (workflows.length === 0) {
        console.log(chalk.yellow('  (none yet — try /spec or /feature-dev)'));
      } else {
        const currentSlug = getCurrentWorkflow(agent.workspaceRoot, agent.sessionKey);
        for (const w of workflows) {
          // Subtask 4: current-pointer marker is now ★ (the spec's chosen
          // glyph). Existing column structure on the first/second lines
          // preserved so script readers don't break — the new goal column
          // lands at the right of the artifact-markers line. The ★
          // reflects THIS session's binding (9d-bugfix), so two CLIs in
          // the same workspace can each see their own bound workflow.
          const marker = w.slug === currentSlug ? chalk.green(' ★') : '';
          console.log(`  ${chalk.cyan(w.slug)} [${chalk.gray(w.status)}] ${chalk.gray(w.kind)}${marker}`);
          console.log(`    ${w.title}`);
          const hasSpec = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.spec);
          const hasTasks = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.tasks);
          const hasWalk = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.walkthrough);
          // Workflows are pure artifact folders now — no goal column.
          // Goal state lives at session scope only; see goalStore.ts.
          console.log(
            chalk.gray(
              `    spec.md:${hasSpec ? '✓' : '·'}  tasks.md:${hasTasks ? '✓' : '·'}  walkthrough.md:${hasWalk ? '✓' : '·'}`,
            ),
          );
        }
      }
      console.log();
      return true;
    }
    case '/skill':
    {
      const skillName = args[0];
      const userInput = args.slice(1).join(' ').trim();
      if (!skillName) {
        console.log(chalk.red('\nUsage: /skill <skill-name> [input]\n'));
        console.log(chalk.gray('Mapped slash commands:'));
        for (const [slash, name] of Object.entries(SLASH_TO_SKILL)) {
          console.log(`  ${chalk.cyan(slash.padEnd(18))} → ${chalk.green(name)}`);
        }
        console.log();
        return true;
      }
      await runSkillByName(agent, mcpClient, skillName, userInput, undefined, ctx.repl.runAgentTurn);
      return true;
    }
    case '/goal':
    {
      const arg = args.join(' ').trim();
      // Eager session resolve — without this, the FIRST /goal of a new
      // CLI session writes goal.json under the deterministic fallback
      // sessionKey, but every later runTurn reads from the
      // MCP-resolved UUID key. Split-brain: kickoff banner shows the
      // new goal, the agent reads a stale one from a different file.
      // ensureInitialized is idempotent and tolerates missing MCP.
      await agent.ensureInitialized();
      const ws = agent.workspaceRoot;
      const sk = agent.sessionKey;
      const showStatus = (g: import('../../state/goalStore.js').Goal | null) => {
        if (!g) {
          console.log(chalk.yellow('\nNo active goal. Set one with: /goal <outcome statement>\n'));
          console.log(chalk.gray('Outcome-first format works best:'));
          console.log(chalk.gray('  /goal <desired end state> verified by <evidence> while preserving <constraints>.\n'));
          return;
        }
        const statusLabel = g.status.replace('_', ' ');
        const status = g.status === 'active' ? chalk.green(statusLabel)
          : g.status === 'paused' ? chalk.yellow(statusLabel)
          : g.status === 'complete' ? chalk.cyan(statusLabel)
          : g.status === 'usage_limited' ? chalk.yellow(statusLabel)
          : chalk.red(statusLabel);
        console.log(chalk.bold('\nGoal'));
        console.log(`  Status:     ${status}`);
        console.log(`  Outcome:    ${chalk.cyan(g.text)}`);
        console.log(`  Iterations: ${g.budget.iterationsUsed}/${formatBudget(g.budget.maxIterations)} used`);
        if (g.budget.maxTokens) {
          console.log(`  Tokens:     ${(g.budget.tokensUsed ?? 0).toLocaleString()}/${g.budget.maxTokens.toLocaleString()} used`);
        }
        console.log(`  Started:    ${chalk.gray(g.startedAt)}`);
        if (g.completedAt) console.log(`  Completed:  ${chalk.gray(g.completedAt)}`);
        if (g.blockedReason) console.log(`  Reason:     ${chalk.gray(g.blockedReason)}`);
        console.log(chalk.gray('\nSubcommands: /goal <text> | pause | resume | complete | clear | budget <n> | tokens <n> | edit <field> <value>\n'));
      };

      if (!arg || arg === 'show') { showStatus(readGoal(ws, sk)); return true; }
      if (arg === 'clear') {
        clearGoal(ws, sk);
        agent.refreshSystemPrompt();
        console.log(chalk.green('\n✓ Goal cleared.\n'));
        return true;
      }
      if (arg === 'pause') {
        const g = pauseGoal(ws, sk);
        if (!g) console.log(chalk.yellow('\nNo active goal to pause.\n'));
        else { agent.refreshSystemPrompt(); console.log(chalk.yellow(`\n⏸  Goal paused. No auto-continuation until /goal resume.\n`)); }
        return true;
      }
      if (arg === 'resume') {
        const g = resumeGoal(ws, sk);
        if (!g) { console.log(chalk.yellow('\nNo goal to resume.\n')); return true; }
        agent.refreshSystemPrompt();
        console.log(chalk.green(`\n▶  Goal resumed (${g.budget.iterationsUsed}/${formatBudget(g.budget.maxIterations)} used). Starting next iteration…\n`));
        // Fire the next iteration immediately so the user doesn't have to type
        // a "proceed" message — the whole point of /goal is autonomy.
        ctx.repl.runAgentTurn(buildGoalKickoffPrompt(g, 'resume'));
        return true; // runAgentTurn owns its prompt cycle
      }
      if (arg === 'complete') {
        const g = completeGoal(ws, sk, 'Marked complete manually by user.');
        if (!g) console.log(chalk.yellow('\nNo goal to mark complete.\n'));
        else { agent.refreshSystemPrompt(); console.log(chalk.green(`\n🎯  Goal marked complete.\n`)); }
        return true;
      }
      if (arg.startsWith('budget')) {
        const n = Number(arg.replace(/^budget\s*/, '').trim());
        if (!Number.isFinite(n) || n < 1) {
          console.log(chalk.red('\nUsage: /goal budget <positive integer>\n'));
          return true;
        }
        const g = setGoalBudget(ws, sk, Math.floor(n));
        if (!g) console.log(chalk.yellow('\nNo goal to update.\n'));
        else {
          agent.refreshSystemPrompt();
          console.log(chalk.green(`\n✓ Iteration budget set to ${formatBudget(g.budget.maxIterations)} (${g.budget.iterationsUsed} already used).\n`));
        }
        return true;
      }
      if (arg.startsWith('tokens')) {
        // /goal tokens <N>     — set the token cap (0 to clear)
        const n = Number(arg.replace(/^tokens\s*/, '').trim());
        if (!Number.isFinite(n) || n < 0) {
          console.log(chalk.red('\nUsage: /goal tokens <non-negative integer> (0 to clear the token cap)\n'));
          return true;
        }
        const g = setGoalTokenBudget(ws, sk, Math.floor(n));
        if (!g) {
          console.log(chalk.yellow('\nNo goal to update.\n'));
          return true;
        }
        agent.refreshSystemPrompt();
        if (n === 0) {
          console.log(chalk.green('\n✓ Token budget cleared (iteration cap still applies).\n'));
        } else {
          console.log(chalk.green(`\n✓ Token budget set to ${g.budget.maxTokens?.toLocaleString()} (${(g.budget.tokensUsed ?? 0).toLocaleString()} already used).\n`));
        }
        return true;
      }
      if (arg.startsWith('edit')) {
        // /goal edit text <new text>
        // /goal edit status <active|paused|complete|blocked|usage_limited>
        // /goal edit budget <N>
        // /goal edit tokens <N>
        const rest = arg.replace(/^edit\s*/, '').trim();
        const [field, ...valueParts] = rest.split(/\s+/);
        const value = valueParts.join(' ').trim();
        if (!field || !value) {
          console.log(chalk.red('\nUsage: /goal edit <field> <value>'));
          console.log(chalk.gray('  fields: text | status | budget | tokens\n'));
          return true;
        }
        try {
          let g: import('../../state/goalStore.js').Goal | null;
          if (field === 'text') {
            g = editGoal(ws, sk, { text: value });
          } else if (field === 'status') {
            const allowed: GoalStatus[] = ['active', 'paused', 'complete', 'blocked', 'usage_limited'];
            if (!(allowed as string[]).includes(value)) {
              console.log(chalk.red(`\nUnknown status "${value}". Allowed: ${allowed.join(', ')}\n`));
              return true;
            }
            g = editGoal(ws, sk, { status: value as GoalStatus });
          } else if (field === 'budget') {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 1) {
              console.log(chalk.red('\n/goal edit budget <positive integer>\n'));
              return true;
            }
            g = editGoal(ws, sk, { maxIterations: Math.floor(n) });
          } else if (field === 'tokens') {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
              console.log(chalk.red('\n/goal edit tokens <non-negative integer>\n'));
              return true;
            }
            g = editGoal(ws, sk, { maxTokens: Math.floor(n) });
          } else {
            console.log(chalk.red(`\nUnknown edit field "${field}". Allowed: text | status | budget | tokens\n`));
            return true;
          }
          if (!g) {
            console.log(chalk.yellow('\nNo goal to edit. Set one first with /goal <text>.\n'));
          } else {
            agent.refreshSystemPrompt();
            console.log(chalk.green(`\n✓ Updated.\n`));
            showStatus(g);
          }
        } catch (err: any) {
          if (err instanceof GoalTooLongError) {
            console.log(chalk.red(`\n✗ ${err.message}\n`));
          } else {
            console.log(chalk.red(`\n✗ ${err?.message ?? err}\n`));
          }
        }
        return true;
      }
      // Anything else is a new goal text — attempt set with conflict
      // detection. If a non-complete goal is already active we throw
      // GoalConflictError and prompt the user before overwriting; a
      // complete goal is replaced silently (the prior work is done, this
      // is just starting fresh and the prompt would be noise).
      //
      // Inline budget parsing: users naturally write "/goal do X. Budget 3
      // iterations." and expect that to set the cap. Without parsing, the
      // goal store falls back to the default (10) and the user is
      // confused by "Budget: 10" in the kickoff banner. We extract the
      // first `budget[:\s]+N[\s iterations?]?` pattern from the text,
      // strip it, and pass N as the maxIterations option.
      let parsedBudget: number | undefined;
      let cleanedText = arg;
      const budgetMatch = arg.match(/\bbudget[:\s]+(\d+)(?:\s*(?:iterations?|turns?|rounds?))?\.?/i);
      if (budgetMatch) {
        const n = Number(budgetMatch[1]);
        if (Number.isFinite(n) && n >= 1 && n <= 200) {
          parsedBudget = Math.floor(n);
          cleanedText = arg.replace(budgetMatch[0], '').replace(/\s{2,}/g, ' ').trim();
        }
      }
      let goal: import('../../state/goalStore.js').Goal;
      try {
        goal = setGoal(ws, cleanedText, sk, parsedBudget !== undefined ? { maxIterations: parsedBudget } : undefined);
      } catch (err: any) {
        if (err instanceof GoalTooLongError) {
          console.log(chalk.red(`\n✗ ${err.message}`));
          console.log(chalk.gray(`  Tip: a goal is a 1–3 sentence outcome statement, not a chat log. Max ${GOAL_TEXT_MAX_CHARS} chars.\n`));
          return true;
        }
        if (err instanceof GoalConflictError) {
          const existing = err.existing;
          console.log(chalk.yellow(`\n⚠️  A goal is already ${existing.status.replace('_', ' ')}:`));
          console.log(`     ${chalk.cyan(existing.text)}`);
          console.log(`     ${chalk.gray(`${existing.budget.iterationsUsed}/${formatBudget(existing.budget.maxIterations)} iterations used`)}`);
          const confirmed = await askYesNo('Replace it with the new objective? (y/N) ', false);
          if (!confirmed) {
            console.log(chalk.gray('\nKeeping the current goal. Use `/goal edit text <new>` to change just the wording.\n'));
            return true;
          }
          // Force-replace. Use the cleaned text + parsed budget so the
          // inline "Budget N" still applies on the second-try path.
          try {
            goal = setGoal(ws, cleanedText, sk, {
              force: true,
              ...(parsedBudget !== undefined ? { maxIterations: parsedBudget } : {}),
            });
          } catch (err2: any) {
            console.log(chalk.red(`\n✗ ${err2?.message ?? err2}\n`));
            return true;
          }
        } else {
          throw err;
        }
      }
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Goal set: ${chalk.cyan(goal.text)}`));

      // Reconcile stale plan items from prior workflows. The plan store is
      // sessionKey-scoped, so a leftover `[⏳]` from an abandoned
      // /feature-dev run blocks goal_complete for an unrelated new goal —
      // the plan-honesty guard correctly refuses, but the user is bitten
      // by cross-contamination they didn't sign up for. Mirror what a
      // smart agent does when context shifts: drop the orphan items and
      // start the new objective with a fresh slate. The cleared items
      // are printed so it's transparent, not silent.
      try {
        const existingPlan = readPlan(ws, sk);
        const orphans = existingPlan.items.filter((i) => i.status !== 'completed');
        if (orphans.length > 0) {
          updatePlan(
            ws,
            { plan: [], explanation: `auto-cleared on new /goal: ${goal.text.slice(0, 80)}` },
            sk,
          );
          console.log(chalk.yellow(`⚠️  Cleared ${orphans.length} stale plan item${orphans.length === 1 ? '' : 's'} from prior work:`));
          for (const it of orphans.slice(0, 5)) {
            const mark = it.status === 'in_progress' ? '⏳' : '☐';
            console.log(chalk.gray(`     ${mark} ${it.step.slice(0, 100)}`));
          }
          if (orphans.length > 5) console.log(chalk.gray(`     …and ${orphans.length - 5} more.`));
          console.log(chalk.gray(`   The agent can rebuild a new plan for this goal via update_plan.`));
        }
      } catch {
        // Plan reconciliation is best-effort — never fatal to the /goal flow.
      }

      {
        const b = formatBudget(goal.budget.maxIterations);
        const budgetLine = b === 'unlimited'
          ? `Budget: unlimited (cap with "/goal budget N" or include "Budget N" in the goal text). The CLI auto-continues until the agent calls goal_complete / goal_blocked or you /goal pause | clear.`
          : `Budget: ${b} iterations. The CLI auto-continues after each turn until the agent calls goal_complete / goal_blocked or you /goal pause | clear.`;
        console.log(chalk.gray(budgetLine));
      }
      console.log(chalk.gray('Kicking off iteration 1 now — type anything to cancel.\n'));
      // Fire the first turn immediately so /goal doesn't require a "proceed"
      // follow-up. The post-turn continuation loop in runAgentTurn handles
      // iterations 2..N.
      ctx.repl.runAgentTurn(buildGoalKickoffPrompt(goal, 'start'));
      return true; // runAgentTurn owns its prompt cycle
    }
    case '/loop':
    {
      const arg0 = args[0];
      if (!arg0 || arg0 === 'status') {
        const state = getLoopState();
        if (!state) console.log(chalk.yellow('\nNo loop running.\n'));
        else {
          console.log(chalk.bold('\nLoop state'));
          console.log(`  Prompt:      ${chalk.cyan(state.prompt)}`);
          console.log(`  Interval:    ${chalk.gray(`${state.intervalMs}ms`)}`);
          console.log(`  Iterations:  ${chalk.gray(state.iterations.toString())}`);
          if (state.lastFiredAt) console.log(`  Last fired:  ${chalk.gray(state.lastFiredAt)}`);
          if (state.lastError) console.log(`  Last error:  ${chalk.red(state.lastError)}`);
          console.log(chalk.gray('\n  Stop with /loop stop\n'));
        }
        return true;
      }
      if (arg0 === 'stop') {
        const ok = stopLoop();
        console.log(ok ? chalk.green('\n✓ Loop stopped.\n') : chalk.yellow('\nNo loop was running.\n'));
        return true;
      }
      const intervalMs = parseInterval(arg0);
      const loopPrompt = args.slice(intervalMs ? 1 : 0).join(' ').trim();
      if (!intervalMs || !loopPrompt) {
        console.log(chalk.red('\nUsage: /loop <interval> <prompt>'));
        console.log(chalk.gray('  e.g. /loop 30s /review'));
        console.log(chalk.gray('       /loop 5m check the deploy status\n'));
        return true;
      }
      const result = startLoop(loopPrompt, intervalMs, async () => {
        // Each tick queues the loop's prompt as if the user typed it. We use
        // the REPL's processing flag to avoid stomping on a turn the user
        // started manually.
        if (ctx.repl.isProcessing()) return;
        console.log(chalk.gray(`\n⟲ Loop tick (iteration ${(getLoopState()?.iterations ?? 0)})`));
        rl.write(`${loopPrompt}\n`);
      });
      if (result.started) {
        console.log(chalk.green(`\n✓ Loop started — "${loopPrompt}" every ${intervalMs}ms.`));
        console.log(chalk.gray('  Stop with /loop stop.\n'));
      } else {
        console.log(chalk.red(`\nLoop not started: ${result.reason}\n`));
      }
      return true;
    }
    case '/continue':
    {
      const last = agent.lastUserPrompt;
      if (!last) {
        console.log(chalk.yellow('\nNothing to continue — no prior prompt this session. Just type your next message.\n'));
        return true;
      }
      // Inspect child-agent state up front so /continue gives the LLM
      // concrete instructions instead of a vague "wait for children". Without
      // this, the model frequently text-replies "I am waiting…" without ever
      // calling wait_agent and the turn just hangs the user.
      reconcileStale(agent.workspaceRoot);
      const allChildren = listSessions(agent.workspaceRoot);
      const running = allChildren.filter((s) => s.status === 'pending' || s.status === 'running');
      const recentlyDone = allChildren
        .filter((s) => s.status === 'completed' || s.status === 'failed')
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 5);

      const sections: string[] = [
        `You were in the middle of working on: "${last}"`,
        '',
      ];
      if (running.length > 0) {
        const ids = running.map((s) => `${s.id} (${s.role}, ${s.status})`).join(', ');
        sections.push(
          `## Children still running`,
          `${running.length} child agent${running.length === 1 ? '' : 's'} have NOT finished yet: ${ids}.`,
          `**You MUST call \`wait_agent\` on each one** before producing a final answer. Do not respond with prose like "I am waiting" — that is a no-op. Issue the tool calls now in this turn.`,
          '',
        );
      }
      if (recentlyDone.length > 0) {
        const lines = recentlyDone.map((s) => `- ${s.id} (${s.role}): ${s.status}${s.error ? ` — ${s.error}` : ''}`);
        sections.push(
          `## Children that already finished`,
          `Use \`read_agent_transcript\` (or the cached finalOutput in \`list_agents\`) to incorporate their work:`,
          ...lines,
          '',
        );
      }
      if (running.length === 0 && recentlyDone.length === 0) {
        sections.push('No child agents are tracked. Pick up where you left off.', '');
      }
      sections.push(
        agent.lastTurnHitLoopLimit
          ? 'You ran out of tool-loop iterations before producing a final answer. Resume now: drain any pending children, then finish writing the workflow artifacts (`spec.md` / `tasks.md` / `walkthrough.md`) before giving a summary.'
          : 'Resume the workflow. Synthesize whatever children produced, then finish writing the artifacts the workflow expects (`spec.md` / `tasks.md` / `walkthrough.md`).',
      );

      ctx.repl.runAgentTurn(sections.join('\n'));
      return true; // runAgentTurn handles its own prompt cycle
    }
  }
  return false;
}
