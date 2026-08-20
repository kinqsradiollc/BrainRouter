/**
 * DESK-5f — pure panel identity and presentation catalog. Kept free of React
 * and panel implementations so layout/recommendation models are Node-testable.
 *
 * ADR-041 A41-7 — this catalog IS the PanelRegistry: one array, one row per
 * panel, each row carrying its full identity (id + title + icon + group). The
 * group used to live in a SEPARATE `GROUP_OF` map that could silently drift from
 * `PANEL_DEFS` — a panel present in one but not the other. Folding `group` into
 * the row makes registration a single edit and `groupOf` a derived lookup, so the
 * two can no longer disagree. The React component stays OUT of the row on purpose
 * (see the module header): the renderer maps id → component in the React layer,
 * which is what keeps this catalog Node-testable.
 */
// ADR-028 G5 — `review` and `ci` are NOT members: they were retired into the
// one `stack` (Pull request) panel. They survive only as keys in
// `lastSessionPanels.PANEL_ID_ALIASES`, which migrates a persisted layout, and
// keeping them out of this union is what stops a new call site opening a tab
// that nothing renders.
// `peers` arrives with ADR-034 (messages that arrive) and IS a member.
export type PanelId = 'context' | 'files' | 'file' | 'editor' | 'diff' | 'terminal' | 'tools' | 'tasks' | 'task-detail' | 'plan' | 'search' | 'schedule' | 'worktrees' | 'stack' | 'comprehension' | 'requirements' | 'annotations' | 'artifacts' | 'attachments' | 'atlas' | 'workflows' | 'memory' | 'knowledge' | 'prototype' | 'servers' | 'browser' | 'peers' | 'runs';

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

/** A registered panel: its identity, presentation, and taxonomy group. */
export interface PanelDef {
  id: PanelId;
  title: string;
  icon: string;
  group: PanelGroup;
}

export const PANEL_DEFS: readonly PanelDef[] = [
  { id: 'context', title: 'Context', icon: 'layout-right', group: 'environment' },
  { id: 'files', title: 'Files', icon: 'folder', group: 'code' },
  { id: 'file', title: 'File', icon: 'file', group: 'code' },
  { id: 'editor', title: 'Editor', icon: 'file', group: 'code' },
  { id: 'diff', title: 'Changes', icon: 'diff', group: 'code' },
  { id: 'terminal', title: 'Terminal', icon: 'terminal', group: 'code' },
  { id: 'tools', title: 'Tool calls', icon: 'bolt', group: 'environment' },
  { id: 'tasks', title: 'Tasks', icon: 'tasks', group: 'work' },
  { id: 'task-detail', title: 'Task', icon: 'tasks', group: 'work' },
  { id: 'plan', title: 'Plan', icon: 'plan', group: 'work' },
  { id: 'search', title: 'Search session', icon: 'search', group: 'code' },
  { id: 'schedule', title: 'Schedules', icon: 'clock', group: 'work' },
  { id: 'worktrees', title: 'Worktrees', icon: 'branch', group: 'work' },
  // ADR-028 G5 — ONE panel for the pull request. `stack`, `review` and `ci`
  // answered facets of a single question — can this land, and if not what is
  // stopping it — and `ci` was already titled "PR / Checks". Four tabs meant
  // assembling the real answer yourself from three of them.
  { id: 'stack', title: 'Pull request', icon: 'branch', group: 'work' },
  // ADR-028 F7/G4 — the Understand group. Kept OUT of the crowded default set:
  // opened when you invoke a comprehension review, never sitting there.
  { id: 'comprehension', title: 'Understand', icon: 'brain', group: 'understand' },

  { id: 'requirements', title: 'Requirements', icon: 'tasks', group: 'knowledge' },
  { id: 'annotations', title: 'Annotations', icon: 'review', group: 'knowledge' },
  { id: 'artifacts', title: 'Artifacts', icon: 'file', group: 'knowledge' },
  { id: 'attachments', title: 'Attachments', icon: 'file', group: 'knowledge' },

  { id: 'atlas', title: 'Atlas', icon: 'atlas', group: 'environment' },
  { id: 'workflows', title: 'Workflows', icon: 'bolt', group: 'work' },
  { id: 'memory', title: 'Saved knowledge', icon: 'pin', group: 'knowledge' },
  { id: 'knowledge', title: 'Project knowledge', icon: 'brain', group: 'knowledge' },
  { id: 'prototype', title: 'Prototype', icon: 'bolt', group: 'environment' },
  { id: 'servers', title: 'Servers', icon: 'globe', group: 'environment' },
  { id: 'peers', title: 'Peers', icon: 'bubble', group: 'environment' },
  { id: 'runs', title: 'Runs', icon: 'activity', group: 'work' },
  { id: 'browser', title: 'Browser', icon: 'globe', group: 'environment' },
];

const HIDDEN_MANUAL_PANEL_IDS = new Set<PanelId>([
  'file',
  'task-detail',
]);

export const MANUAL_PANEL_DEFS = PANEL_DEFS.filter((panel) => !HIDDEN_MANUAL_PANEL_IDS.has(panel.id));

export const PANEL_GROUPS: ReadonlyArray<readonly [PanelGroup, string]> = [
  ['code', 'Code'],
  ['work', 'Work'],
  ['knowledge', 'Knowledge'],
  ['understand', 'Understand'],
  ['environment', 'Environment'],
];

// Derived from PANEL_DEFS — the single source of truth. Built once so `groupOf`
// is an O(1) lookup in the hot filter paths below.
const GROUP_OF: ReadonlyMap<PanelId, PanelGroup> = new Map(PANEL_DEFS.map((d) => [d.id, d.group]));

/** Which group a panel belongs to. Unmapped ids fall to Environment. */
export function groupOf(id: PanelId): PanelGroup {
  return GROUP_OF.get(id) ?? 'environment';
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
