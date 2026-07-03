import fs from 'node:fs';
import path from 'node:path';
import type { McpClient } from '@kinqs/brainrouter-core/mcp';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { skillSearchRoots, parseDisallowedToolsFrontmatter, type SkillListItem } from './skillCatalog.js';

export interface SkillResolution {
  name: string;
  body: string;
  source: 'mcp' | 'filesystem' | 'fallback';
  /**
   * CC-SKILLS-D3 — tools this skill forbids for the turn it runs (parsed from
   * `disallowed-tools` in the SKILL.md frontmatter). Reuses the agent's role
   * `disallowedTools` blacklist path. Empty when the skill declares none.
   */
  disallowedTools?: string[];
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
  '/simplify': 'code-simplification',
  '/test': 'testing-skill',
};

/**
 * Resolve a skill by name. Prefers the MCP server (so users get whatever the
 * server has loaded, including their own private skills), falls back to a
 * local filesystem scan of `skills/` for when the MCP tool is unavailable.
 */
export async function resolveSkill(
  mcpClient: McpClient,
  name: string,
  workspaceRoot: string,
  section: RunSkillOptions['section'] = 'full',
): Promise<SkillResolution> {
  try {
    const res: any = await mcpClient.callTool('get_skill', { name, section });
    if (!res.isError && Array.isArray(res.content) && res.content[0]?.text) {
      const body = res.content[0].text as string;
      return { name, body, source: 'mcp', disallowedTools: parseDisallowedToolsFrontmatter(body) };
    }
  } catch {
    // Fall through to filesystem lookup.
  }

  const body = readSkillFromFilesystem(workspaceRoot, name);
  if (body) {
    return { name, body, source: 'filesystem', disallowedTools: parseDisallowedToolsFrontmatter(body) };
  }

  return {
    name,
    body: `(No SKILL.md found for "${name}". Use your general judgement and the agentic-engineering-workflow defaults.)`,
    source: 'fallback',
    disallowedTools: [],
  };
}

/**
 * CC-SKILLS-D1 — parse the leading `/skill` tokens from a raw prompt.
 * `"/a /b do the thing"` → `{ skills: ['a','b'], rest: 'do the thing' }`.
 *
 * Only a CONTIGUOUS run of leading `/token` words counts; the first
 * non-slash word ends the stack and everything from there is the user input.
 * The stack is capped (default 5, `cli.skillsStackMax`, hard max 5) — extra
 * leading skills beyond the cap are dropped from the stack and folded back
 * into `rest` so nothing is silently lost. A bare `/` or `/skill`/`/skills`
 * command word is NOT treated as a stack token (those are handled by the
 * normal slash-command dispatcher).
 */
export function parseStackedSkillTokens(
  input: string,
  cap = getCliKnobs().skillsStackMax,
): { skills: string[]; rest: string } {
  const hardCap = Math.min(5, Math.max(1, cap || 5));
  const trimmed = input.trimStart();
  // Must begin with at least TWO leading /skill tokens to count as "stacked".
  // A single "/foo bar" stays on the ordinary slash-command path.
  const tokens = trimmed.split(/\s+/);
  const reserved = new Set(['/skill', '/skills']);
  const skills: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('/') || tok.length < 2 || reserved.has(tok)) break;
    const name = tok.slice(1);
    if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) break; // not a plausible skill name
    skills.push(name);
  }
  if (skills.length < 2) return { skills: [], rest: input };
  // Cap the stack; fold any overflow tokens back into the user input so the
  // model still sees them (as literal text) rather than dropping them.
  const kept = skills.slice(0, hardCap);
  const overflow = skills.slice(hardCap).map((s) => `/${s}`);
  const rest = [...overflow, ...tokens.slice(i)].join(' ').trim();
  return { skills: kept, rest };
}

/** MC-E2 — a dormant skill armed by a keyword hit in the user prompt. */
export interface TriggeredSkillHit {
  name: string;
  /** The declared trigger word/phrase that fired (as spelled in SKILL.md). */
  trigger: string;
}

/**
 * MC-E2 — scan a user prompt for the keyword triggers of DORMANT skills.
 * A skill fires when one of its declared `triggers:`/`keywords:` words appears
 * in the prompt as a whole word (case-insensitive, word-boundary — `plan`
 * matches "Plan the rollout" but NOT "airplane" or "planning"). At most one
 * hit per skill (the first matching trigger wins), skills already invoked
 * explicitly are excluded via `opts.exclude`, and the TOTAL of
 * excluded + triggered skills is capped at the same stacked-skill limit
 * (`cli.skillsStackMax`, hard max 5) so a trigger storm can't compose an
 * unbounded instruction block.
 *
 * Kill-switch: `cli.skillsKeywordTriggers` (default true). Pure — no
 * filesystem access; callers pass the catalog (e.g. `listFilesystemSkills`).
 */
export function matchTriggeredSkills(
  prompt: string,
  skills: ReadonlyArray<Pick<SkillListItem, 'name' | 'triggers'>>,
  opts: { exclude?: string[]; cap?: number; enabled?: boolean } = {},
): TriggeredSkillHit[] {
  const enabled = opts.enabled ?? getCliKnobs().skillsKeywordTriggers;
  if (!enabled) return [];
  if (!prompt.trim()) return [];
  const cap = Math.min(5, Math.max(1, opts.cap ?? getCliKnobs().skillsStackMax ?? 5));
  const taken = new Set((opts.exclude ?? []).map((n) => n.toLowerCase()));
  const hits: TriggeredSkillHit[] = [];
  for (const skill of skills) {
    if (taken.size >= cap) break; // explicit + triggered share one budget
    if (!skill.triggers?.length) continue; // dormant only when triggers declared
    if (taken.has(skill.name.toLowerCase())) continue; // already invoked/triggered
    const trigger = skill.triggers.find((t) => triggerMatchesPrompt(prompt, t));
    if (trigger === undefined) continue;
    taken.add(skill.name.toLowerCase());
    hits.push({ name: skill.name, trigger });
  }
  return hits;
}

/** MC-E2 — case-insensitive whole-word/phrase match (no substring hits). */
function triggerMatchesPrompt(prompt: string, trigger: string): boolean {
  const word = trigger.trim();
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(prompt);
}

/**
 * CC-SKILLS-D1 — resolve an ordered list of skills and compose their bodies
 * into one multi-phase instruction block ahead of the user input. Unresolved
 * (fallback) skills are skipped so a typo doesn't poison the whole stack. The
 * union of every resolved skill's `disallowed-tools` is returned so the caller
 * can apply the strictest blacklist for the turn.
 */
export async function resolveStackedSkills(
  mcpClient: McpClient,
  names: string[],
  workspaceRoot: string,
): Promise<{ resolved: SkillResolution[]; disallowedTools: string[] }> {
  const resolved: SkillResolution[] = [];
  const disallowed = new Set<string>();
  for (const name of names) {
    const skill = await resolveSkill(mcpClient, name, workspaceRoot, 'full');
    if (skill.source === 'fallback') continue; // skip unknown — don't poison the stack
    resolved.push(skill);
    for (const t of skill.disallowedTools ?? []) disallowed.add(t);
  }
  return { resolved, disallowedTools: [...disallowed] };
}

/**
 * CC-SKILLS-D1 — build one prompt that runs several skills in order as
 * numbered phases, followed by the user input. Mirrors buildSkillPrompt's
 * structure so the agent sees a familiar layout.
 */
export function buildStackedSkillPrompt(
  skills: SkillResolution[],
  options: RunSkillOptions = {},
): string {
  const sections: string[] = [];
  const names = skills.map((s) => s.name).join(' → ');
  sections.push(`# Executing stacked skills: ${names}`);
  sections.push(`Run these skills IN ORDER as sequential phases; carry context forward between them.`);
  skills.forEach((skill, idx) => {
    sections.push('');
    sections.push(`## Phase ${idx + 1} — skill: ${skill.name} (source: ${skill.source})`);
    sections.push(skill.body.trim());
  });
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
    '- Report run progress with `workflow_progress(step, status)`.',
    '- Persist meaningful outputs through BrainRouter memory tools as the skills dictate.',
    '- Always synthesize child outputs in your own words before claiming work is done.',
  ].join('\n'));
  if (options.orchestration?.trim()) {
    sections.push('');
    sections.push('## CLI orchestration hints');
    sections.push(options.orchestration.trim());
  }
  return sections.join('\n');
}

/** Validate a skill name for `/skill init`: kebab/underscore identifier only. */
export function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][\w-]*$/.test(name);
}

/**
 * CC-SKILLS-D4 — the SKILL.md template a fresh `/skill init <name>` scaffolds.
 * Uses BrainRouter's OWN frontmatter (name/description/disallowed-tools) — no
 * '.claude' anything. Pure so tests can assert the shape.
 */
export function renderSkillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: One-line summary of when to use the ${name} skill.`,
    '# CC-SKILLS-D3 — optionally forbid tools for the turn this skill runs, e.g.:',
    '# disallowed-tools: [run_command, write_file]',
    '---',
    '',
    `# ${name}`,
    '',
    '## When to use',
    '',
    `Describe the situations where the ${name} skill should be invoked.`,
    '',
    '## Workflow',
    '',
    '1. First step.',
    '2. Second step.',
    '3. Verify the outcome.',
    '',
    '## Red flags',
    '',
    '- Note anti-patterns the agent should avoid.',
    '',
  ].join('\n');
}

export interface ScaffoldSkillResult {
  path: string;
  created: boolean;
}

/**
 * CC-SKILLS-D4 — scaffold `<workspaceRoot>/.brainrouter/skills/<name>/SKILL.md`
 * from the template. BrainRouter's OWN local skill root — never a '.claude'
 * path. Returns the file path and whether it was newly created. When the file
 * already exists it is NOT overwritten unless `force` is set.
 */
export function scaffoldSkill(
  workspaceRoot: string,
  name: string,
  opts: { force?: boolean } = {},
): ScaffoldSkillResult {
  if (!isValidSkillName(name)) {
    throw new Error(`Invalid skill name "${name}" — use letters, digits, dashes or underscores.`);
  }
  const dir = path.join(workspaceRoot, '.brainrouter', 'skills', name);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && !opts.force) {
    return { path: file, created: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, renderSkillTemplate(name), 'utf8');
  return { path: file, created: true };
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
    '- Report run progress with `workflow_progress(step, status)` — call it with status="running" as you begin each numbered step and status="done" (or "failed"/"skipped") when it finishes. This drives the live `/workflows` view and makes the run survive a restart.',
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
