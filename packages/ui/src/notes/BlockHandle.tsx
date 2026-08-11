/**
 * ADR-029 E4 — the handle beside a block.
 *
 * Two gestures on one control, which is why it is one control: dragging it
 * moves the block (including into and out of a nesting level), and clicking it
 * opens what can be done to the block without touching its text. A separate
 * drag target and menu button would put two 12-pixel controls in a margin
 * people are trying to read past.
 *
 * Markup only. Where a drop lands, whether it is allowed, what "move to" may
 * offer and which conversions keep the words are all decided in
 * the sibling `blockSelection` helper — a drag is exactly the kind of gesture whose rules
 * are impossible to test once they live inside pointer handlers.
 */
import React from 'react';
import { Icon } from './Icon.js';
import {
  BLOCK_ACTIONS, turnIntoOptions, type BlockAction, type MoveToTarget,
} from './blockSelection.js';
import type { SlashCommandDto } from './slashMenu.js';

export function BlockHandle({
  open, onOpen, onAddBelow, onDragStart, onDragEnd, commands, currentKind, moveTargets,
  onTurnInto, onAction, onMoveTo, backlinkNote, sendTargets, onSendTo, selectedCount,
  canCopyLink,
}: {
  open: boolean;
  onOpen: () => void;
  onAddBelow: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  /** Core's catalog through the host — the same list the slash menu offers. */
  commands: readonly SlashCommandDto[];
  currentKind: string;
  moveTargets: readonly MoveToTarget[];
  onTurnInto: (command: SlashCommandDto) => void;
  onAction: (action: BlockAction) => void;
  onMoveTo: (target: MoveToTarget) => void;
  /** A2 — "what links here", asked for when the menu opens and not before. */
  backlinkNote: string | null;
  /** C2 — the cross-mode moves this line offers. */
  sendTargets: readonly { id: string; label: string }[];
  onSendTo: (id: string) => void;
  /** E4 — one action over several blocks, when several are selected. */
  selectedCount: number;
  /** Clipboard effects are host-owned; omit their action when unavailable. */
  canCopyLink: boolean;
}): React.ReactElement {
  return (
    <div className="notes-handle-wrap">
      <button
        className="notes-handle-add" title="Add a block below" aria-label="Add a block below"
        onClick={onAddBelow}
      >
        <Icon name="plus" size={11} />
      </button>
      <button
        className="notes-handle" title="Drag to move · click for actions" aria-label="Block actions"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
      >
        <Icon name="dots" size={12} />
      </button>

      {open ? (
        <div className="notes-menu" role="menu">
          {selectedCount > 1 ? (
            <div className="notes-menu-note">{`${selectedCount} blocks selected — this applies to all of them.`}</div>
          ) : null}
          {backlinkNote ? <div className="notes-backlinks">{backlinkNote}</div> : null}

          {BLOCK_ACTIONS.filter((action) => action.id !== 'copy-link' || canCopyLink).map((action) => (
            <button
              key={action.id} role="menuitem"
              className={action.id === 'delete' ? 'danger' : undefined}
              onClick={() => onAction(action.id)}
            >
              {action.label}
            </button>
          ))}

          {moveTargets.length > 0 ? (
            <div className="notes-menu-group">
              <span className="notes-menu-head">Move to</span>
              {moveTargets.slice(0, 8).map((target) => (
                <button key={target.id ?? 'top'} role="menuitem" onClick={() => onMoveTo(target)}>
                  {target.title}
                </button>
              ))}
            </div>
          ) : null}

          <div className="notes-menu-group">
            <span className="notes-menu-head">Turn into</span>
            {turnIntoOptions(commands).map((command) => (
              <button
                key={command.id} role="menuitem" disabled={command.kind === currentKind && !command.level}
                onClick={() => onTurnInto(command)}
              >
                {command.label}
                {command.marker ? <span className="notes-menu-marker">{command.marker.trim()}</span> : null}
              </button>
            ))}
          </div>

          {sendTargets.length > 0 ? (
            <div className="notes-menu-group">
              <span className="notes-menu-head">Send to</span>
              {sendTargets.map((target) => (
                <button key={target.id} role="menuitem" onClick={() => onSendTo(target.id)}>{target.label}</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
