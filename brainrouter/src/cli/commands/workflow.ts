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
import ora from 'ora';
import { marked } from 'marked';
import { LOCAL_TOOLS } from '../../agent/agent.js';
import { callMcpTool } from '../../runtime/mcpUtils.js';
import { listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, listWorkflows, readArtifact, updateWorkflowStatus } from '../../state/workflowArtifacts.js';
import { clearGoal, completeGoal, GoalTooLongError, GOAL_TEXT_MAX_CHARS, pauseGoal, readGoal, resumeGoal, setGoal, setGoalBudget } from '../../state/goalStore.js';
import { formatPlan, readPlan, updatePlan } from '../../state/taskStore.js';
import { getLoopState, parseInterval, startLoop, stopLoop } from '../../runtime/loopRunner.js';
import type { CommandContext } from './_context.js';
import { SLASH_TO_SKILL } from '../../prompt/skillRunner.js';
import { buildGoalKickoffPrompt, runSkillByName, runSkillCommand } from './_helpers.js';

// Promise-flavored exec for case bodies that shell out.
const execPromise = promisify(exec);


export async function tryHandleWorkflowCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/skills':
    {
      const spinner = ora(chalk.gray('Fetching skills...')).start();
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

      const spinner = ora(chalk.gray('Fetching MCP tools...')).start();
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
      const state = readPlan(agent.workspaceRoot, agent.sessionKey);
      console.log(chalk.bold('\nPlan:'));
      console.log(chalk.gray(formatPlan(state)));
      if (state.updatedAt) {
        console.log(chalk.gray(`Updated: ${state.updatedAt}`));
      }
      console.log();
      return true;
    }
    case '/diff':
    {
      // Stream the diff instead of buffering. The old execPromise approach
      // read the whole diff into memory, then colored every line in a JS
      // loop before any output appeared — for a 5k-line diff that took
      // seconds and you saw nothing until completion. Now: spawn `git diff
      // --color=always` and pipe stdout directly. Claude Code 2.1.147
      // improved diff rendering performance the same way.
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
      const spinner = ora(chalk.gray('Checking git status...')).start();
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
      const feature = args.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /feature-dev <feature description>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'feature-dev' });
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
    case '/spec':
    {
      const feature = args.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /spec <feature title>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'spec' });
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
      const scope = args.join(' ').trim() || 'current unstaged and staged changes (git diff HEAD)';
      const meta = createWorkflow(agent.workspaceRoot, { title: `Review: ${scope}`, kind: 'review' });
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
      const currentSlug = getCurrentWorkflow(agent.workspaceRoot);
      const slug = currentSlug ?? createWorkflow(agent.workspaceRoot, { title: next.step, kind: 'implement-plan' }).slug;
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
      const slug = args[0] || getCurrentWorkflow(agent.workspaceRoot);
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
    case '/workflows':
    {
      const workflows = listWorkflows(agent.workspaceRoot);
      console.log(chalk.bold('\nDurable Workflows'));
      if (workflows.length === 0) {
        console.log(chalk.yellow('  (none yet — try /spec or /feature-dev)'));
      } else {
        const currentSlug = getCurrentWorkflow(agent.workspaceRoot);
        for (const w of workflows) {
          const marker = w.slug === currentSlug ? chalk.green(' ← current') : '';
          console.log(`  ${chalk.cyan(w.slug)} [${chalk.gray(w.status)}] ${chalk.gray(w.kind)}${marker}`);
          console.log(`    ${w.title}`);
          const hasSpec = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.spec);
          const hasTasks = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.tasks);
          const hasWalk = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.walkthrough);
          console.log(chalk.gray(`    spec.md:${hasSpec ? '✓' : '·'}  tasks.md:${hasTasks ? '✓' : '·'}  walkthrough.md:${hasWalk ? '✓' : '·'}`));
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
      const ws = agent.workspaceRoot;
      const sk = agent.sessionKey;
      const showStatus = (g: import('../../state/goalStore.js').Goal | null) => {
        if (!g) {
          console.log(chalk.yellow('\nNo active goal. Set one with: /goal <outcome statement>\n'));
          console.log(chalk.gray('Outcome-first format works best:'));
          console.log(chalk.gray('  /goal <desired end state> verified by <evidence> while preserving <constraints>.\n'));
          return true;
        }
        const status = g.status === 'active' ? chalk.green(g.status)
          : g.status === 'paused' ? chalk.yellow(g.status)
          : g.status === 'complete' ? chalk.cyan(g.status)
          : chalk.red(g.status);
        console.log(chalk.bold('\nGoal'));
        console.log(`  Status:     ${status}`);
        console.log(`  Outcome:    ${chalk.cyan(g.text)}`);
        console.log(`  Budget:     ${g.budget.iterationsUsed}/${g.budget.maxIterations} iterations used`);
        console.log(`  Started:    ${chalk.gray(g.startedAt)}`);
        if (g.completedAt) console.log(`  Completed:  ${chalk.gray(g.completedAt)}`);
        if (g.blockedReason) console.log(`  Note:       ${chalk.gray(g.blockedReason)}`);
        console.log(chalk.gray('\nSubcommands: /goal <text> | pause | resume | complete | clear | budget <n>\n'));
      };

      if (!arg || arg === 'show') { showStatus(readGoal(ws, sk)); break; }
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
        if (!g) { console.log(chalk.yellow('\nNo goal to resume.\n')); break; }
        agent.refreshSystemPrompt();
        console.log(chalk.green(`\n▶  Goal resumed (${g.budget.iterationsUsed}/${g.budget.maxIterations} used). Starting next iteration…\n`));
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
        else { agent.refreshSystemPrompt(); console.log(chalk.green(`\n✓ Budget set to ${g.budget.maxIterations} iterations (${g.budget.iterationsUsed} already used).\n`)); }
        return true;
      }
      // Anything else is a new goal text.
      let goal: import('../../state/goalStore.js').Goal;
      try {
        goal = setGoal(ws, arg, sk);
      } catch (err: any) {
        if (err instanceof GoalTooLongError) {
          console.log(chalk.red(`\n✗ ${err.message}`));
          console.log(chalk.gray(`  Tip: a goal is a 1–3 sentence outcome statement, not a chat log. Max ${GOAL_TEXT_MAX_CHARS} chars.\n`));
          return true;
        }
        throw err;
      }
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Goal set: ${chalk.cyan(goal.text)}`));
      console.log(chalk.gray(`Budget: ${goal.budget.maxIterations} iterations. The CLI will auto-continue after each turn until the agent calls goal_complete / goal_blocked or you /goal pause | clear.`));
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
