/**
 * Compact, persistent acknowledgement of the active workbench mode. The rail
 * is icon-only, so this says what the switch changed without turning each
 * destination into a branded landing page.
 */
import React from 'react';
import { Icon } from '../../icons.js';
import {
  workspaceModeDefinition,
  type ModeTransition,
  type WorkspaceMode,
} from '../../lib/workspace/modes.js';

export function ModeContext(props: {
  mode: WorkspaceMode;
  transition: ModeTransition | null;
}): React.ReactElement {
  const definition = workspaceModeDefinition(props.mode);
  const message = props.transition?.to === props.mode
    ? props.transition.message
    : definition.summary;

  return (
    <div className="mode-context" data-mode={props.mode} role="status" aria-live="polite" aria-atomic="true">
      <Icon name={definition.icon} size={14} />
      <span className="mode-context-title"><strong>{definition.label}</strong><span>{definition.scope}</span></span>
      <span className="mode-context-copy">{message}</span>
    </div>
  );
}
