/**
 * ADR-027 D6 (P4-5) — workbench feature parity, agent-operable.
 *
 * The inventory of workbench actions, declared once. This is what makes "the
 * agent can drive the workbench" true rather than aspirational: a feature that
 * is not in this list is not agent-reachable, and that absence is now visible
 * and testable instead of being an unstated gap.
 *
 * Handlers are INJECTED. This module owns the contract — the id, the effect
 * class, the parameters, the wording the model reads — while the desktop owns
 * the implementations. Keeping them apart is what lets the contract be tested
 * without an Electron window, and what stops the effect classification from
 * drifting away from the thing it classifies.
 *
 * Effect classification is the load-bearing part, so it is decided here, next
 * to the description, rather than at each call site where it would be decided
 * differently each time.
 */
import {
  createRegistry,
  type ControlAction,
  type ControlRegistry,
  type EffectClass,
  type ParamSpec,
} from './controlLayer.js';

/** Every workbench capability the agent may drive, with its declared effect. */
export interface WorkbenchHandlers {
  listSessions(args: Record<string, unknown>): unknown;
  openSession(args: Record<string, unknown>): unknown;
  renameSession(args: Record<string, unknown>): unknown;
  archiveSession(args: Record<string, unknown>): unknown;
  deleteSession(args: Record<string, unknown>): unknown;
  listWorkspaces(args: Record<string, unknown>): unknown;
  switchWorkspace(args: Record<string, unknown>): unknown;
  pinSessionToWorktree(args: Record<string, unknown>): unknown;
  listAttachments(args: Record<string, unknown>): unknown;
  readAttachment(args: Record<string, unknown>): unknown;
  runLocalReview(args: Record<string, unknown>): unknown;
  describeStack(args: Record<string, unknown>): unknown;
  adviseStacking(args: Record<string, unknown>): unknown;
  createStackLayer(args: Record<string, unknown>): unknown;
  openPanel(args: Record<string, unknown>): unknown;
  setTheme(args: Record<string, unknown>): unknown;
}

interface Spec {
  id: string;
  title: string;
  effect: EffectClass;
  params: Record<string, ParamSpec>;
  handler: keyof WorkbenchHandlers;
}

const str = (description: string, required = true): ParamSpec =>
  ({ type: 'string', required, description });

/**
 * The declared inventory.
 *
 * Ordering note: `archive` is `mutate` while `delete` is `destructive`. That is
 * the same distinction the inactivity sweep draws — archiving is reversible,
 * deletion cascades to transcripts and attachments — and it must be drawn the
 * same way here, or the agent gets a confirmation prompt for the safe action
 * and none for the unsafe one.
 */
const SPECS: readonly Spec[] = [
  {
    id: 'session.list', title: 'List sessions in the current workspace',
    effect: 'read', params: {}, handler: 'listSessions',
  },
  {
    id: 'session.open', title: 'Open a session by id',
    effect: 'mutate', params: { sessionId: str('Id of the session to open') },
    handler: 'openSession',
  },
  {
    id: 'session.rename', title: 'Rename a session',
    effect: 'mutate',
    params: { sessionId: str('Id of the session'), name: str('The new name') },
    handler: 'renameSession',
  },
  {
    id: 'session.archive', title: 'Archive a session (reversible)',
    effect: 'mutate', params: { sessionId: str('Id of the session') },
    handler: 'archiveSession',
  },
  {
    id: 'session.delete',
    title: 'Delete a session and everything it owns',
    effect: 'destructive', params: { sessionId: str('Id of the session') },
    handler: 'deleteSession',
  },
  {
    id: 'workspace.list', title: 'List known workspaces',
    effect: 'read', params: {}, handler: 'listWorkspaces',
  },
  {
    id: 'workspace.switch', title: 'Point the window at a different workspace',
    effect: 'mutate', params: { workspaceRoot: str('Absolute path of the workspace') },
    handler: 'switchWorkspace',
  },
  {
    id: 'session.pintoworktree',
    title: 'Run this session in a worktree without moving the window',
    effect: 'mutate',
    params: { sessionId: str('Id of the session'), worktreePath: str('Absolute path of the worktree') },
    handler: 'pinSessionToWorktree',
  },
  {
    id: 'attachment.list', title: 'List attachments in the current session',
    effect: 'read', params: {}, handler: 'listAttachments',
  },
  {
    id: 'attachment.read', title: 'Read an attachment as context',
    effect: 'read', params: { attachmentId: str('Id of the attachment') },
    handler: 'readAttachment',
  },
  {
    id: 'review.runlocal', title: 'Run the local pre-commit review over uncommitted changes',
    effect: 'read', params: {}, handler: 'runLocalReview',
  },
  {
    id: 'stack.describe',
    title: 'Show a stacked pull request: its layers, what can merge, and what is waiting',
    effect: 'read', params: { pullNumber: str('Any pull request number in the stack') },
    handler: 'describeStack',
  },
  {
    id: 'stack.advise',
    title: 'Advise whether the current change should be split into a stack, and where to cut it',
    effect: 'read', params: {}, handler: 'adviseStacking',
  },
  {
    id: 'stack.addlayer',
    title: 'Add a layer on top of a stacked pull request',
    // `mutate`, not `destructive`: it opens a pull request, which is reversible
    // by closing it. Nothing existing is rewritten.
    effect: 'mutate',
    params: {
      onPullNumber: str('The pull request this layer stacks on top of'),
      head: str('Branch name for the new layer'),
      title: str('Title for the new pull request'),
    },
    handler: 'createStackLayer',
  },
  {
    id: 'panel.open', title: 'Open a workbench panel',
    effect: 'mutate', params: { panel: str('Panel name, e.g. "browser" or "review"') },
    handler: 'openPanel',
  },
  {
    id: 'appearance.settheme', title: 'Switch between the light and dark theme',
    effect: 'mutate', params: { theme: str('Either "light" or "dark"') },
    handler: 'setTheme',
  },
];

/** Ids in the inventory, sorted. Exported so parity can be asserted. */
export const WORKBENCH_ACTION_IDS: readonly string[] =
  [...SPECS.map((s) => s.id)].sort();

/** Build the workbench registry from injected handlers. */
export function workbenchRegistry(handlers: WorkbenchHandlers): ControlRegistry {
  const actions: ControlAction[] = SPECS.map((spec) => ({
    id: spec.id,
    title: spec.title,
    effect: spec.effect,
    params: spec.params,
    run: (args: Record<string, unknown>) => handlers[spec.handler](args),
  }));
  return createRegistry(actions);
}

/**
 * Which capabilities exist but are NOT agent-reachable.
 *
 * Parity is a claim that decays: someone adds a panel and the agent silently
 * cannot open it. Passing the known capability list here turns that decay into
 * a failing assertion instead of a discovery months later.
 */
export function parityGaps(allCapabilityIds: readonly string[]): readonly string[] {
  const declared = new Set(WORKBENCH_ACTION_IDS);
  return [...allCapabilityIds].filter((id) => !declared.has(id)).sort();
}
