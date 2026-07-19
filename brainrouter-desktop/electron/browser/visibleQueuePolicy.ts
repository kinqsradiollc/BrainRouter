const AGENT_VISIBLE_RECOVERY_COMMANDS = new Set([
  'dialog.respond',
  'permission.respond',
  'page.stop',
]);

const RENDERER_VISIBLE_RECOVERY_COMMANDS = new Set([
  'respond-dialog',
  'respond-permission',
  'stop',
]);

/** Recovery is re-entrant only on the tab already pinned and visible. */
export function shouldBypassAgentVisibleQueue(kind: string, targetIsVisible: boolean): boolean {
  return targetIsVisible && AGENT_VISIBLE_RECOVERY_COMMANDS.has(kind);
}

/**
 * Prompt/load recovery must not queue behind the operation it releases. Tab
 * selection is also safe to admit: the manager defers it while an agent pin is
 * active, and otherwise it should remain responsive while another tab loads.
 */
export function shouldBypassRendererVisibleQueue(op: string, targetIsVisible: boolean): boolean {
  return op === 'select-tab'
    || (targetIsVisible && RENDERER_VISIBLE_RECOVERY_COMMANDS.has(op));
}
