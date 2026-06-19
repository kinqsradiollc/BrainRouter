/**
 * Helpers shared across multiple slash-command handler files.
 *
 * Stays small on purpose — anything used by only one category file should
 * live in that file. The functions here are the cross-cutting bits that
 * 3+ categories reach for: print-an-MCP-call helpers, the goal-kickoff
 * prompt builder, the transcript content formatter, and the skill runner
 * wrapper.
 */

import chalk from 'chalk';
import { spinner } from '../spinner.js';
import type { Agent } from '../../agent/agent.js';
import type { McpClientPool as McpClientWrapper } from '../../runtime/mcpPool.js';
import { callMcpTool } from '../../runtime/mcpUtils.js';
import { clampPayload, extractMemories, renderMemoryCards } from '../../memory/formatters.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from '../../prompt/skillRunner.js';

/**
 * Memory-aware variant of printMcpCall. Calls the tool, extracts the flat
 * record list from whatever shape it returns, and renders compact cards
 * (recordId, type, scene, content preview). Falls back to printMcpCall's
 * raw output only when no records can be parsed.
 */
export async function printMemoryCards(
  mcpClient: McpClientWrapper,
  toolName: string,
  args: Record<string, unknown>,
  heading: string,
): Promise<void> {
  const s = spinner(chalk.gray(`${toolName}…`)).start();
  const res = await callMcpTool<any>(mcpClient, toolName, args);
  s.stop();
  console.log();
  if (res.isError) {
    console.log(chalk.red(`${heading}: tool error — ${res.text || '(no message)'}`));
    return;
  }
  const cards = extractMemories(res.parsed);
  if (cards.length > 0) {
    console.log(renderMemoryCards(cards, heading));
  } else {
    console.log(chalk.bold(heading));
    const preview = clampPayload(res.text, 2000).trim();
    console.log(preview ? chalk.gray(preview) : chalk.yellow('  (empty result)'));
    console.log();
  }
}

/**
 * Generic MCP call printer — used by /handover, /explain, /failed, /verify,
 * /audit, /persona, /skill-hints, and anywhere else we just want to dump
 * the tool's text output under a heading.
 */
export async function printMcpCall(
  mcpClient: McpClientWrapper,
  toolName: string,
  args: Record<string, unknown>,
  heading: string,
): Promise<void> {
  const s = spinner(chalk.gray(`${toolName}…`)).start();
  const res = await callMcpTool(mcpClient, toolName, args);
  s.stop();
  console.log(chalk.bold(`\n${heading}`));
  if (res.isError) {
    console.log(chalk.red(`  Tool error: ${res.text || '(no message)'}`));
    console.log();
    return;
  }
  if (!res.text.trim()) {
    console.log(chalk.yellow('  (empty result)'));
    console.log();
    return;
  }
  const preview = res.text.length > 4000
    ? res.text.slice(0, 4000) + chalk.gray(`\n…(${res.text.length - 4000} chars truncated)`)
    : res.text;
  console.log(chalk.gray(preview));
  console.log();
}

/**
 * Format a transcript entry's content for compact display in /transcript
 * and /agent. Strips whitespace, JSON-stringifies non-strings, caps at 240
 * chars so long tool payloads don't blow scrollback.
 */
export function formatTranscriptContent(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Prompt the agent receives for the FIRST turn after /goal <text> or
 * /goal resume. Once this turn finishes, runAgentTurn's continuation loop
 * keeps firing iterations 2..N until the agent calls goal_complete or
 * goal_blocked, the budget runs out, or the user interrupts.
 */
// §ADR-003 — extracted to core so the Desktop host builds the same prompt.
export { buildGoalKickoffPrompt } from '@kinqs/brainrouter-core/dist/goal/goalKickoff.js';

/**
 * Resolve a slash-mapped skill (/spec, /feature-dev, /review, /implement-plan)
 * to a SKILL.md body, refuse fallback placeholders, latch activeSkill on the
 * agent, and hand the assembled prompt to the supplied runTurn callback.
 * Centralized here so /skill itself and the workflow shortcuts share one path.
 */
export async function runSkillCommand(
  agent: Agent,
  mcpClient: McpClientWrapper,
  slashCommand: string,
  userInput: string,
  orchestration: string | undefined,
  runTurn: (prompt: string) => void,
): Promise<void> {
  const skillName = SLASH_TO_SKILL[slashCommand];
  if (!skillName) {
    console.log(chalk.red(`\nNo skill mapped to ${slashCommand}.\n`));
    return;
  }
  await runSkillByName(agent, mcpClient, skillName, userInput, orchestration, runTurn);
}

export async function runSkillByName(
  agent: Agent,
  mcpClient: McpClientWrapper,
  skillName: string,
  userInput: string,
  orchestration: string | undefined,
  runTurn: (prompt: string) => void,
): Promise<void> {
  const loader = spinner(chalk.gray(`Loading skill: ${skillName}...`)).start();
  let prompt: string;
  try {
    const skill = await resolveSkill(mcpClient, skillName, agent.workspaceRoot, 'full');
    if (skill.source === 'fallback') {
      // resolveSkill returns a placeholder body for unknown names; running it
      // burns an LLM call on nothing. Refuse early and tell the user what's
      // actually installed.
      loader.fail(chalk.red(`Unknown skill "${skillName}".`));
      console.log(chalk.gray('  Run `/skills` to list installed skills, or call `search_skills` for fuzzy matches.\n'));
      return;
    }
    loader.succeed(chalk.green(`Skill loaded: ${skillName} (${skill.source})`));
    prompt = buildSkillPrompt(skill, { input: userInput, orchestration });
  } catch (err: any) {
    loader.fail(chalk.red(`Failed to resolve skill "${skillName}": ${err.message}`));
    return;
  }
  // Mark the skill active so memory_recall / memory_capture_turn see it.
  // The activeSkill stays latched while the turn runs; runAgentTurn's
  // continuation loop will clear it via the post-turn hook.
  agent.activeSkill = skillName;
  runTurn(prompt);
}
