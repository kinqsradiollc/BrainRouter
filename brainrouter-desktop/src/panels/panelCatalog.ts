/**
 * DESK-5f — pure panel identity and presentation catalog. Kept free of React
 * and panel implementations so layout/recommendation models are Node-testable.
 */
// ADR-028 G5 — `review` and `ci` are NOT members: they were retired into the
// one `stack` (Pull request) panel. They survive only as keys in
// `lastSessionPanels.PANEL_ID_ALIASES`, which migrates a persisted layout, and
// keeping them out of this union is what stops a new call site opening a tab
// that nothing renders.
export type PanelId = 'context' | 'files' | 'file' | 'editor' | 'diff' | 'terminal' | 'tools' | 'tasks' | 'task-detail' | 'plan' | 'search' | 'schedule' | 'worktrees' | 'stack' | 'comprehension' | 'requirements' | 'annotations' | 'artifacts' | 'attachments' | 'atlas' | 'workflows' | 'memory' | 'knowledge' | 'prototype' | 'servers' | 'browser';

export const PANEL_DEFS: Array<{ id: PanelId; title: string; icon: string }> = [
  { id: 'context', title: 'Context', icon: 'layout-right' },
  { id: 'files', title: 'Files', icon: 'folder' },
  { id: 'file', title: 'File', icon: 'file' },
  { id: 'editor', title: 'Editor', icon: 'file' },
  { id: 'diff', title: 'Changes', icon: 'diff' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal' },
  { id: 'tools', title: 'Tool calls', icon: 'bolt' },
  { id: 'tasks', title: 'Tasks', icon: 'tasks' },
  { id: 'task-detail', title: 'Task', icon: 'tasks' },
  { id: 'plan', title: 'Plan', icon: 'plan' },
  { id: 'search', title: 'Search session', icon: 'search' },
  { id: 'schedule', title: 'Schedules', icon: 'clock' },
  { id: 'worktrees', title: 'Worktrees', icon: 'branch' },
  // ADR-028 G5 — ONE panel for the pull request. `stack`, `review` and `ci`
  // answered facets of a single question — can this land, and if not what is
  // stopping it — and `ci` was already titled "PR / Checks". Four tabs meant
  // assembling the real answer yourself from three of them.
  { id: 'stack', title: 'Pull request', icon: 'branch' },
  // ADR-028 F7/G4 — the Understand group. Kept OUT of the crowded default set:
  // opened when you invoke a comprehension review, never sitting there.
  { id: 'comprehension', title: 'Understand', icon: 'brain' },

  { id: 'requirements', title: 'Requirements', icon: 'tasks' },
  { id: 'annotations', title: 'Annotations', icon: 'review' },
  { id: 'artifacts', title: 'Artifacts', icon: 'file' },
  { id: 'attachments', title: 'Attachments', icon: 'file' },

  { id: 'atlas', title: 'Atlas', icon: 'atlas' },
  { id: 'workflows', title: 'Workflows', icon: 'bolt' },
  { id: 'memory', title: 'Saved knowledge', icon: 'pin' },
  { id: 'knowledge', title: 'Project knowledge', icon: 'brain' },
  { id: 'prototype', title: 'Prototype', icon: 'bolt' },
  { id: 'servers', title: 'Servers', icon: 'globe' },
  { id: 'browser', title: 'Browser', icon: 'globe' },
];

const HIDDEN_MANUAL_PANEL_IDS = new Set<PanelId>([
  'file',
  'task-detail',
]);

export const MANUAL_PANEL_DEFS = PANEL_DEFS.filter((panel) => !HIDDEN_MANUAL_PANEL_IDS.has(panel.id));


/**
 * ADR-028 G3 — panel groups.
 *
 * Twenty-six flat ids is a list you scan, not a strip you navigate. The
 * grouping is not new information: it is the structure the panel list already
 * had implicitly, made visible.
 *
 * **Where it is consumed:** the views chooser in
 * `components/layout/ViewsRail.tsx`, which is the list you scan. It used to
 * carry its OWN five group names in a local constant, so the app had two
 * panel taxonomies and only one of them was this one. The open-tab strip stays
 * flat on purpose — G2 means it starts empty and only ever holds the tabs you
 * opened yourself, so there is nothing there to scan.
 *
 * `diff` sits in Code rather than Work deliberately — reading a change is a
 * different activity from deciding whether to land it. That argument is
 * recorded in the ADR as one deserving a second look, since it would also have
 * justified keeping the stack panel separate, which G5 says was wrong.
 */
export type PanelGroup = 'code' | 'work' | 'knowledge' | 'understand' | 'environment';

export const PANEL_GROUPS: ReadonlyArray<readonly [PanelGroup, string]> = [
  ['code', 'Code'],
  ['work', 'Work'],
  ['knowledge', 'Knowledge'],
  ['understand', 'Understand'],
  ['environment', 'Environment'],
];

const GROUP_OF: Partial<Record<PanelId, PanelGroup>> = {
  files: 'code', file: 'code', editor: 'code', diff: 'code', search: 'code', terminal: 'code',
  plan: 'work', tasks: 'work', 'task-detail': 'work', stack: 'work', worktrees: 'work',
  schedule: 'work', workflows: 'work',
  memory: 'knowledge', knowledge: 'knowledge', artifacts: 'knowledge',
  annotations: 'knowledge', requirements: 'knowledge', attachments: 'knowledge',
  comprehension: 'understand',
  tools: 'environment', servers: 'environment', browser: 'environment',
  context: 'environment', atlas: 'environment', prototype: 'environment',
};

/** Which group a panel belongs to. Unmapped ids fall to Environment. */
export function groupOf(id: PanelId): PanelGroup {
  return GROUP_OF[id] ?? 'environment';
}

/** The panels in a group, in catalog order. */
export function panelsInGroup(group: PanelGroup, ids: readonly PanelId[]): PanelId[] {
  return ids.filter((id) => groupOf(id) === group);
}

/**
 * The groups these panels fall into, in catalog order.
 *
 * Only these are shown, so the chooser never offers a group with nothing in
 * it — an empty heading is a row that leads nowhere. Pass the ids currently on
 * offer: the launchers left after the search filter, or the open tabs.
 */
export function activeGroups(ids: readonly PanelId[]): PanelGroup[] {
  const present = new Set(ids.map(groupOf));
  return PANEL_GROUPS.filter(([g]) => present.has(g)).map(([g]) => g);
}
