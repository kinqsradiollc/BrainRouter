import fs from 'node:fs';
import path from 'node:path';
import type { McpClientPool as McpClientWrapper } from '../runtime/mcpPool.js';
import { skillSearchRoots } from './skillCatalog.js';

export interface SkillResolution {
  name: string;
  body: string;
  source: 'mcp' | 'filesystem' | 'fallback';
}

export interface RunSkillOptions {
  /** Free-text input from the user (e.g., feature description, review scope). */
  input?: string;
  /** Optional extra orchestration directives appended after the skill body. */
  orchestration?: string;
  /** Skill section to fetch from get_skill. Defaults to "workflow" — pass "full" for the entire SKILL.md. */
  section?: 'description' | 'overview' | 'when_to_use' | 'workflow' | 'usage' | 'detailed_instructions' | 'phases' | 'checklist' | 'red_flags' | 'rationalizations' | 'full';
}

/**
 * Slash-command → skill mapping. Each entry names the skill catalogued in
 * the BrainRouter skills/ folder (and exposed by the MCP server) that the
 * command delegates to. The CLI sends a thin prompt; the heavy lifting lives
 * in the skill body, so authoring is centralized.
 */
export const SLASH_TO_SKILL: Record<string, string> = {
  '/feature-dev': 'agentic-engineering-workflow',
  '/review': 'code-review-and-quality',
  '/implement-plan': 'incremental-skill',
  '/spec': 'spec-driven-skill',
  '/plan-write': 'planning-skill',
  '/debug': 'debug-skill',
  '/handover': 'handover-skill',
  '/commit-skill': 'git-workflow-skill',
  '/changelog': 'changelog-generator',
  '/refactor': 'code-simplification',
  '/test': 'testing-skill',
};

/**
 * Resolve a skill by name. Prefers the MCP server (so users get whatever the
 * server has loaded, including their own private skills), falls back to a
 * local filesystem scan of `skills/` for when the MCP tool is unavailable.
 */
export async function resolveSkill(
  mcpClient: McpClientWrapper,
  name: string,
  workspaceRoot: string,
  section: RunSkillOptions['section'] = 'full',
): Promise<SkillResolution> {
  try {
    const res: any = await mcpClient.callTool('get_skill', { name, section });
    if (!res.isError && Array.isArray(res.content) && res.content[0]?.text) {
      return { name, body: res.content[0].text, source: 'mcp' };
    }
  } catch {
    // Fall through to filesystem lookup.
  }

  const body = readSkillFromFilesystem(workspaceRoot, name);
  if (body) {
    return { name, body, source: 'filesystem' };
  }

  return {
    name,
    body: `(No SKILL.md found for "${name}". Use your general judgement and the agentic-engineering-workflow defaults.)`,
    source: 'fallback',
  };
}

function readSkillFromFilesystem(workspaceRoot: string, name: string): string | undefined {
  for (const root of skillSearchRoots(workspaceRoot)) {
    if (!fs.existsSync(root)) continue;
    const match = findSkillDir(root, name);
    if (match) {
      try { return fs.readFileSync(path.join(match, 'SKILL.md'), 'utf8'); } catch { /* ignore */ }
    }
  }
  return undefined;
}

function findSkillDir(rootDir: string, skillName: string, depth = 5): string | undefined {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(rootDir, entry.name);
    if (entry.name === skillName && fs.existsSync(path.join(child, 'SKILL.md'))) {
      return child;
    }
    const nested = findSkillDir(child, skillName, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Build the user prompt that asks the agent to execute a skill. The skill
 * body is embedded so the agent does not need to round-trip through
 * `get_skill` again. Orchestration affordances (spawn_agent, update_plan)
 * are reminded explicitly so multi-agent workflows are actually triggered.
 */
export function buildSkillPrompt(skill: SkillResolution, options: RunSkillOptions = {}): string {
  const sections: string[] = [];
  sections.push(`# Executing skill: ${skill.name}`);
  sections.push(`Source: ${skill.source}`);
  sections.push('');
  sections.push('## Skill instructions');
  sections.push(skill.body.trim());
  if (options.input?.trim()) {
    sections.push('');
    sections.push('## User input');
    sections.push(options.input.trim());
  }
  sections.push('');
  sections.push('## Execution affordances');
  sections.push([
    '- You may delegate bounded parallel work with `spawn_agent` (roles: explorer, architect, reviewer, worker, verifier).',
    '- Keep the durable plan current with `update_plan`. At most one item should be `in_progress`.',
    '- Persist meaningful outputs through BrainRouter memory tools (`memory_capture_turn`, `memory_working_offload`) as the skill dictates.',
    '- Always synthesize child outputs in your own words before claiming work is done.',
  ].join('\n'));
  if (options.orchestration?.trim()) {
    sections.push('');
    sections.push('## CLI orchestration hints');
    sections.push(options.orchestration.trim());
  }
  return sections.join('\n');
}
