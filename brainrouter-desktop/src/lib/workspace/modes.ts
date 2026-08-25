/**
 * The active mode changes agent access, data freshness, scope, and which
 * workspace chrome is available. Keeping that contract in a pure module lets
 * the rail, transition feedback, and cross-mode links agree on what changed.
 */

export const WORKSPACE_MODE_IDS = ['chat', 'code', 'track', 'meetings', 'planner', 'notes', 'study'] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODE_IDS)[number];

export interface WorkspaceModeDefinition {
  id: WorkspaceMode;
  label: string;
  icon: string;
  scope: string;
  summary: string;
  access: string;
}

export const WORKSPACE_MODE_DEFINITIONS: readonly WorkspaceModeDefinition[] = [
  {
    id: 'chat', label: 'Chat', icon: 'bubble', scope: 'Conversation',
    summary: 'Read, search, and reason in the current conversation.',
    access: 'Read-only agent access',
  },
  {
    id: 'code', label: 'Code', icon: 'code', scope: 'This workspace',
    summary: 'Use files, views, and the terminal for the current project.',
    access: 'Workspace tools available',
  },
  {
    id: 'track', label: 'Track', icon: 'tasks', scope: 'This workspace',
    summary: 'Manage the project’s work, Git state, checks, and review status.',
    access: 'Project state refreshes while open',
  },
  {
    id: 'meetings', label: 'Meetings', icon: 'mic', scope: 'Organization',
    summary: 'Capture discussions and turn decisions into accountable next steps.',
    access: 'Capture continues when you leave the view',
  },
  {
    id: 'planner', label: 'Planner', icon: 'plan', scope: 'Across projects',
    summary: 'Review personal plans that are not limited to one workspace.',
    access: 'Workspace panels stay out of this view',
  },
  {
    id: 'notes', label: 'Notes', icon: 'note', scope: 'Across projects',
    summary: 'Write and connect personal notes that are not limited to one workspace.',
    access: 'Workspace panels stay out of this view',
  },
  {
    id: 'study', label: 'Study', icon: 'study', scope: 'This workspace',
    summary: 'Build decks and review what this project taught you — spaced repetition.',
    access: 'Decks live in the workspace; review progress is personal',
  },
];

const MODES_BY_ID = new Map(WORKSPACE_MODE_DEFINITIONS.map((definition) => [definition.id, definition]));

export function workspaceModeDefinition(mode: WorkspaceMode): WorkspaceModeDefinition {
  return MODES_BY_ID.get(mode)!;
}

/** The public workspace-reference modes that own a full Desktop surface. */
export function modeForWorkspaceReference(mode: string): WorkspaceMode | null {
  return MODES_BY_ID.has(mode as WorkspaceMode) ? mode as WorkspaceMode : null;
}

export interface ModeTransition {
  from: WorkspaceMode;
  to: WorkspaceMode;
  changed: boolean;
  message: string;
}

/**
 * State-changing consequences only. Presentation reads this result; access and
 * refresh effects stay in their owning hooks so renderer state never pretends
 * it has authority over the host.
 */
export function describeModeTransition(from: WorkspaceMode, to: WorkspaceMode): ModeTransition {
  if (from === to) return { from, to, changed: false, message: workspaceModeDefinition(to).summary };

  const message = to === 'chat'
    ? 'The current conversation stays selected. Read-only agent access is active for new requests.'
    : to === 'code'
      ? 'The current conversation stays selected. Workspace tools are available for new requests.'
      : to === 'track'
        ? 'Refreshing this workspace’s work, Git, checks, and review state.'
        : to === 'meetings'
          ? 'Meeting capture stays active if you move to another mode.'
          : to === 'study'
            ? 'Reviewing this workspace’s decks. Your review progress is personal to you.'
            : 'This personal view spans projects, so workspace panels are kept out of the way.';

  return { from, to, changed: true, message };
}
