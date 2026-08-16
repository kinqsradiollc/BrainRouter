/**
 * ADR-032 D3 — a repeated procedure becomes something that RUNS, and it cannot
 * live in the shipped library.
 *
 * §1's first gap is that a reusable workflow is prose: a description the model
 * re-reads and re-interprets every turn, so nothing the agent learns ever
 * becomes something that executes. Promoting it to a skill fixes that — and
 * collides head-on with ADR-031, which is why the collision is resolved here
 * rather than assumed away.
 *
 * **ADR-031 made `skills/` a single source with generated, gitignored copies.**
 * Writing a learned skill there fails two ways: into a package copy it is
 * deleted by the next build (`syncContentDir` replaces the directory outright),
 * and into the root library it would ship to every user of the product. Both
 * are silent.
 *
 * So learned skills live HERE — user-scoped, under the brainrouter home, in the
 * same `(org_id, user_id)` partition as the rest of the learned state, loaded
 * beside the library and never merged into it. Three consequences, taken
 * deliberately:
 *
 * 1. **Labelled.** Every id carries the `learned-` prefix and every file opens
 *    with a banner saying the agent wrote it. A person must always be able to
 *    tell a shipped skill from one their agent invented, and a naming rule does
 *    that at every surface at once — the catalog, `get_skill`, the file on
 *    disk — rather than at whichever one remembered to.
 * 2. **Promotion to the library is a human action** — a pull request, not a
 *    threshold. A skill that reaches everyone is a product decision.
 * 3. **ADR-031's byte-for-byte drift check does not extend here**, and cannot:
 *    `checkBundledSkills` compares `<package>/skills` against the root library,
 *    and this directory is under the user's home, in neither. That is verified
 *    by a test rather than asserted, because "it should not see it" is exactly
 *    the kind of claim that is true until someone adds a second content dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getLearnedItem, learningDir, listLearnedItems } from './store.js';
import type { LearnedProcedureStep, LearnedTenant } from './types.js';

/**
 * The prefix that makes a learned skill unmistakable — and unable to shadow a
 * shipped one. Collision resolution by naming beats collision resolution by
 * lookup order, because lookup order is invisible at the call site.
 */
export const LEARNED_SKILL_PREFIX = 'learned-';

/** Matches the shipped library's own id rule, plus the mandatory prefix. */
const LEARNED_SKILL_ID = /^learned-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A skill is instructions, not a document. The library's own cap is 256KiB. */
const MAX_SKILL_BYTES = 64 * 1024;

export interface LearnedSkillResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly metadata: {
    readonly scope: 'learned';
    readonly tokenEstimate: number;
    readonly learnedItemId?: string;
    readonly learnedAt?: string;
    readonly allowedTools: readonly string[];
  };
}

export interface LearnedSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly learnedItemId?: string;
  readonly learnedAt?: string;
  readonly allowedTools: readonly string[];
}

export function learnedSkillsDir(tenant: LearnedTenant): string {
  return path.join(learningDir(tenant), 'skills');
}

/**
 * `Deploy the worker first` plus its durable item id becomes a one-owner skill
 * id. Omitting the item id retains the legacy slug-only form for reading old
 * state; every production promotion supplies it.
 */
export function learnedSkillId(title: string, learnedItemId?: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  const base = `${LEARNED_SKILL_PREFIX}${slug || 'procedure'}`;
  if (!learnedItemId) return base;
  const owner = createHash('sha256').update(learnedItemId).digest('hex').slice(0, 12);
  return `${base}-${owner}`;
}

export function isLearnedSkillId(name: string): boolean {
  return LEARNED_SKILL_ID.test(name);
}

export interface WriteLearnedSkillInput {
  readonly tenant: LearnedTenant;
  readonly id: string;
  readonly description: string;
  /** The steps, already gated. One per entry; they are rendered as a list. */
  readonly steps: readonly string[];
  /** D2's falsifier, carried into the file so the skill states its own limits. */
  readonly falsifier: string;
  readonly learnedItemId: string;
  readonly sessionKey: string;
  readonly learnedAt: string;
  readonly allowedTools: readonly string[];
  /**
   * D3 — the calls the RUNTIME watched succeed, as distinct from `steps`, which
   * are the model's retelling of them. Rendered as its own section because the
   * difference matters to a reader: one is evidence, the other is a summary of
   * evidence, and a skill that blurs them invites the agent to trust prose at
   * the same level as a recorded fact.
   */
  readonly observedActions?: readonly LearnedProcedureStep[];
}

/**
 * Render the runtime's ledger, or nothing at all.
 *
 * Absent rather than empty when there is no ledger: a "What actually ran"
 * heading with nothing under it reads as "nothing ran", which is a different
 * and false claim from "this procedure was learned before ledgers existed".
 */
function observedActionsSection(actions: readonly LearnedProcedureStep[]): string[] {
  if (actions.length === 0) return [];
  return [
    '## What actually ran',
    '',
    '> Recorded by the runtime from calls it watched succeed — not written by the',
    '> model. The steps above are its retelling; these are the calls themselves.',
    '',
    ...actions.map((action, index) =>
      `${index + 1}. \`${action.toolName}\`${action.summary ? ` — ${sanitizeSummary(action.summary)}` : ''}`),
    '',
  ];
}

/**
 * A summary reaches this file from a tool result, and tool results carry
 * whatever the world put in them. It is rendered into a Markdown document the
 * agent reads back as instructions, so it cannot be allowed to introduce a
 * heading, a fence, or a line of its own.
 */
function sanitizeSummary(summary: string): string {
  return summary
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_#[\]<>|\\]/g, '')
    .trim()
    .slice(0, 160);
}

/**
 * Write a learned skill. Returns its path, or undefined when the id is not one
 * we would ever serve — a malformed id is refused at the WRITE, so the reader
 * never has to decide whether a file it found is trustworthy.
 */
export function writeLearnedSkill(input: WriteLearnedSkillInput): string | undefined {
  if (!isLearnedSkillId(input.id)) return undefined;
  const steps = input.steps
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (steps.length === 0) return undefined;

  const root = learnedSkillsDir(input.tenant);
  const dir = path.join(root, input.id);
  fs.mkdirSync(root, { recursive: true });
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    const owner = readLearnedSkillOwner(path.join(dir, 'SKILL.md'));
    if (owner !== input.learnedItemId) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    try {
      fs.mkdirSync(dir);
    } catch {
      // Another writer may have won the create. It is safe only when it wrote
      // the same owner's complete skill.
      const owner = readLearnedSkillOwner(path.join(dir, 'SKILL.md'));
      if (owner !== input.learnedItemId) return undefined;
    }
  }
  const body = [
    '---',
    `name: ${input.id}`,
    `description: ${yamlScalar(input.description)}`,
    'origin: learned',
    `learned-item: ${input.learnedItemId}`,
    `learned-session: ${yamlScalar(input.sessionKey)}`,
    `learned-at: ${input.learnedAt}`,
    `allowed-tools: ${JSON.stringify(input.allowedTools.slice(0, 32))}`,
    '---',
    '',
    `# ${input.id}`,
    '',
    '> Your agent wrote this skill from a procedure it saw repeated. It is NOT part of',
    "> BrainRouter's shipped skill library, and it applies only to this account.",
    '',
    '## Workflow',
    '',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    ...observedActionsSection(input.observedActions ?? []),
    '## When this stops applying',
    '',
    `${input.falsifier}`,
    '',
  ].join('\n');
  const file = path.join(dir, 'SKILL.md');
  const temporary = path.join(dir, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, body, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return file;
}

/** Remove a learned skill — the file half of D4's undo. */
export function removeLearnedSkill(
  tenant: LearnedTenant,
  id: string,
  expectedLearnedItemId: string,
): boolean {
  if (!isLearnedSkillId(id)) return false;
  const dir = path.join(learnedSkillsDir(tenant), id);
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (readLearnedSkillOwner(path.join(dir, 'SKILL.md')) !== expectedLearnedItemId) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function readLearnedSkillOwner(file: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    return frontmatter(fs.readFileSync(descriptor, 'utf8'))['learned-item'];
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function uniqueStoredSkillOwner(
  tenant: LearnedTenant,
  skillId: string,
  learnedItemId: string,
): ReturnType<typeof getLearnedItem> {
  const owners = listLearnedItems(tenant).filter((item) => item.skillId === skillId);
  if (owners.length !== 1 || owners[0]?.id !== learnedItemId) return undefined;
  return owners[0];
}

/**
 * Serve one learned skill.
 *
 * Only answers for `learned-` ids, so this can be tried in any order relative
 * to the library without a learned skill ever shadowing a shipped one. The
 * containment and symlink checks mirror `skillToolAdapter.readResolvedSkillFile`
 * for the same reason it has them: this is a directory a process can be pointed
 * at by configuration, and a link out of it is a file read we did not intend.
 */
export function resolveLearnedSkill(
  tenant: LearnedTenant,
  name: string,
): LearnedSkillResult | undefined {
  if (!isLearnedSkillId(name)) return undefined;
  const root = learnedSkillsDir(tenant);
  const file = path.join(root, name, 'SKILL.md');
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    const realFile = fs.realpathSync(file);
    const relative = path.relative(fs.realpathSync(root), realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const text = fs.readFileSync(descriptor, 'utf8');
    const front = frontmatter(text);
    const learnedItemId = front['learned-item'];
    if (!learnedItemId) return undefined;
    const item = uniqueStoredSkillOwner(tenant, name, learnedItemId);
    // The file is not authority. A demoted, retired, or reverted item must be
    // unrunnable even if a process crashed before cleaning up its skill file.
    if (
      !item || item.status !== 'active' || item.skillId !== name
      || (item.memoryLifecycle && item.memoryLifecycle.status !== 'active')
    ) return undefined;
    return {
      content: [{ type: 'text', text }],
      metadata: {
        scope: 'learned',
        tokenEstimate: Math.ceil(text.length / 4),
        learnedItemId,
        ...(front['learned-at'] ? { learnedAt: front['learned-at'] } : {}),
        allowedTools: [...(item.allowedTools ?? [])],
      },
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Everything this account's agent has written, for the catalog.
 *
 * The description is prefixed rather than left as written: `list_skills` is
 * where a person or a model decides what to invoke, and that is the moment the
 * distinction between shipped and learned has to be visible.
 */
export function listLearnedSkills(tenant: LearnedTenant): LearnedSkillSummary[] {
  const root = learnedSkillsDir(tenant);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LearnedSkillSummary[] = [];
  for (const entry of entries.slice(0, 128)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!isLearnedSkillId(entry.name)) continue;
    let front: Record<string, string>;
    try {
      const raw = fs.readFileSync(path.join(root, entry.name, 'SKILL.md'), 'utf8');
      front = frontmatter(raw);
    } catch {
      continue;
    }
    if (front.name !== entry.name) continue;
    const learnedItemId = front['learned-item'];
    if (!learnedItemId) continue;
    const item = uniqueStoredSkillOwner(tenant, entry.name, learnedItemId);
    if (
      !item || item.status !== 'active' || item.skillId !== entry.name
      || (item.memoryLifecycle && item.memoryLifecycle.status !== 'active')
    ) continue;
    out.push({
      name: entry.name,
      description: `(learned by your agent) ${front.description ?? entry.name}`,
      learnedItemId,
      ...(front['learned-at'] ? { learnedAt: front['learned-at'] } : {}),
      allowedTools: [...(item.allowedTools ?? [])],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Frontmatter, read as flat `key: value` scalars.
 *
 * A YAML parser is deliberately not used: this file format is one we write
 * ourselves, the reader only needs five known keys, and the smaller surface is
 * the point — a learned skill is the one file in the system an LLM's output
 * influenced, so the parser it meets should be boring.
 */
function frontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n').slice(0, 32)) {
    const pair = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/i);
    if (!pair) continue;
    out[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Keep a model-written description on one line and inside the quotes. */
function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, ' ').trim().slice(0, 200));
}
