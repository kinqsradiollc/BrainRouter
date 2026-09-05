/**
 * The routed design vocabulary (ADR-056 D-B4).
 *
 * One visual-craft skill (`hallmark`) with a verb table, a mode axis, and the
 * worlds it routes to — instead of a folder of style skills a user could not
 * tell apart. `/design <verb>` in either head becomes a bounded agent turn
 * that names the verb's reference file inside the skill, so what the agent
 * does is what the skill says, not what the model recalls. The data here is
 * the contract a drift test holds against the shipped skill: every verb has
 * its reference file and its row in the skill's Commands table.
 */
export const DESIGN_SKILL_ID = 'hallmark';

/** The verbs, in the order the skill's table lists them. */
export const DESIGN_VERBS = [
  { id: 'critique', edits: false, detectFirst: true, summary: 'two verdicts kept apart — fit against product.md, craft against the tells' },
  { id: 'audit', edits: false, detectFirst: true, summary: 'ranked anti-pattern punch list with file:line and a one-line fix each' },
  { id: 'redesign', edits: true, detectFirst: true, summary: 'new visual structure inside the existing implementation boundaries' },
  { id: 'study', edits: false, detectFirst: false, summary: 'extract the DNA of a screenshot or URL into a diagnosis' },
  { id: 'shape', edits: false, detectFirst: false, summary: 'brief → concept: macrostructure, world, type, the one asymmetry, trade-offs' },
  { id: 'layout', edits: true, detectFirst: true, summary: 'grid, section order and rhythm, alignment — the skeleton' },
  { id: 'typeset', edits: true, detectFirst: true, summary: 'one type system: pairing, scale, measure, leading, tokens' },
  { id: 'colorize', edits: true, detectFirst: true, summary: 'colour as roles with passing contrast and tokens' },
  { id: 'animate', edits: true, detectFirst: true, summary: 'motion that explains a change; reduced motion honoured' },
  { id: 'polish', edits: true, detectFirst: true, summary: 'the last five percent: spacing, alignment, states, detail' },
  { id: 'harden', edits: true, detectFirst: true, summary: 'empty / loading / error / overflow / keyboard / zoom — reality' },
  { id: 'onboard', edits: true, detectFirst: true, summary: 'first-run and zero-data paths that teach by doing' },
  { id: 'adapt', edits: true, detectFirst: true, summary: 'breakpoints from content, touch targets, platform fit' },
  { id: 'optimize', edits: true, detectFirst: true, summary: 'perceived performance: no shift, matching skeletons, fonts that do not flash' },
  { id: 'clarify', edits: true, detectFirst: true, summary: 'words, labels, hierarchy, affordances — the next action is obvious' },
  { id: 'distill', edits: true, detectFirst: true, summary: 'fewer elements, same meaning; never deletes routes or data' },
  { id: 'bolder', edits: true, detectFirst: true, summary: 'a stronger point of view without noise' },
  { id: 'quieter', edits: true, detectFirst: true, summary: 'lower the volume; hierarchy survives' },
  { id: 'document', edits: true, detectFirst: true, summary: 'design.md written from what the code actually does' },
  { id: 'product', edits: true, detectFirst: false, summary: 'product.md: audience, jobs, non-goals, vocabulary, feel' },
] as const;

export type DesignVerbId = (typeof DESIGN_VERBS)[number]['id'];
export type DesignVerb = (typeof DESIGN_VERBS)[number];
export const DESIGN_VERB_IDS: readonly DesignVerbId[] = DESIGN_VERBS.map((v) => v.id);

export function isDesignVerb(value: string): value is DesignVerbId {
  return (DESIGN_VERB_IDS as readonly string[]).includes(value);
}

export function designVerb(id: DesignVerbId): DesignVerb {
  return DESIGN_VERBS.find((v) => v.id === id) as DesignVerb;
}

/** Path of a verb's playbook, relative to the skill directory. */
export function designVerbReference(verb: DesignVerbId): string {
  return `references/verbs/${verb}.md`;
}

/** What the page is for — sets a verb's defaults, never its steps. */
export const DESIGN_MODES = [
  { id: 'persuade', summary: 'move a reader to one action' },
  { id: 'operate', summary: 'let someone work fast for hours' },
  { id: 'read', summary: 'be understood end to end' },
  { id: 'experience', summary: 'be felt as much as used' },
] as const;
export type DesignModeId = (typeof DESIGN_MODES)[number]['id'];
export function isDesignMode(value: string): value is DesignModeId {
  return DESIGN_MODES.some((m) => m.id === value);
}

/** The former style skills, now worlds the one skill routes to (references/genres/worlds.md). */
export const DESIGN_STYLE_SKILL_IDS = [
  'brutalist-skill', 'minimalist-skill', 'soft-skill', 'gpt-tasteskill', 'taste-skill', 'stitch-skill', 'redesign-skill',
] as const;
/** The skill's native genres, also worlds. */
export const DESIGN_GENRE_IDS = ['editorial', 'modern-minimal', 'atmospheric', 'playful'] as const;
export const DESIGN_WORLD_IDS: readonly string[] = [...DESIGN_GENRE_IDS, ...DESIGN_STYLE_SKILL_IDS];

export interface DesignVerbRequest {
  verb: DesignVerbId;
  targets?: string[];
  mode?: DesignModeId;
  world?: string;
  brief?: string;
}

/**
 * The bounded brief a `/design <verb>` turn starts from. It names the skill,
 * the verb's reference file, the mode/world, the target, and the two rules
 * every verb shares (detector first when the verb says so; editing verbs
 * must not raise the count). The playbook itself stays in the skill.
 */
export function designVerbPrompt(req: DesignVerbRequest): string {
  const v = designVerb(req.verb);
  const targets = (req.targets ?? []).filter(Boolean);
  const lines = [
    `/design ${v.id}: run the \`${v.id}\` verb of the \`${DESIGN_SKILL_ID}\` design skill — ${v.summary}.`,
    `1. Load the skill's \`${designVerbReference(v.id)}\` and follow it step by step; it is the whole playbook for this verb. ${req.mode ? `Mode: ${req.mode} — load \`references/modes.md\` and apply its defaults.` : 'Infer the mode from the target (`references/modes.md`) and say which you chose.'}${req.world ? ` World: ${req.world} — route to it per \`references/genres/worlds.md\`.` : ''}`,
    `2. Target: ${targets.length ? targets.join(', ') : 'the UI files this workspace is about; ask once if that is unclear'}.`,
    v.detectFirst
      ? '3. Run design_detect on the target before you judge or change anything; its findings are the deterministic half — verify each in context, drop false positives with a reason.'
      : '3. The detector has nothing to check for this verb yet; do not run it first.',
    v.edits
      ? '4. This verb edits in place, additively. Name the files you will touch before touching them; no route or file deletions without confirmation. Run design_detect again when done — the count must not rise.'
      : '4. This verb edits nothing. Report only.',
  ];
  if (req.brief) lines.push(`Brief: ${req.brief}`);
  lines.push('Finish with a receipt: what you found or changed, what you left alone, and why.');
  return lines.join('\n');
}
