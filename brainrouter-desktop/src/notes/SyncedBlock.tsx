/**
 * ADR-029 F3 — the synced block, showing the one block it points at.
 *
 * F1 is the reason this file exists rather than the model alone: `Synced block`
 * was in the slash menu, core knew what one was, and the row fell through to the
 * shared prose editor — so choosing it gave you a paragraph containing a URL.
 * That is the exact defect Part F is named for, committed on a kind Part F
 * added, and a menu entry whose block has no renderer is not built.
 *
 * **What is drawn is the SOURCE's rows, carrying the SOURCE's ids.** So typing
 * here writes to the one block through the same `notes-update` any other line
 * uses — nothing redirects a write, because there is nothing else to write to.
 * Core's rule is that the mirror stores an address and never the words, and this
 * component is what that rule looks like on screen.
 *
 * **Every state that is not `ready` renders core's sentence.** Denied, gone,
 * malformed, a cycle — each one says what happened where the content would be,
 * because a mirror that rendered nothing makes one person's page look different
 * from another's with no indication why (A4's argument, and C5's).
 *
 * The picker is the `@` mention list, so a mirror can address any block a
 * mention can and the two menus cannot rank the same characters differently.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons.js';
import { BlockEditor } from './BlockEditor.js';
import {
  SYNCED_EMPTY_INVITATION, syncedFooter, syncedIndent, syncedMarker, syncedRowIsProse,
  type SyncedReadDto, type SyncedRowDto,
} from '../lib/notes/syncedView.js';
import { placeholderFor } from '../lib/notes/notesView.js';
import type { MentionCandidate } from '../lib/notes/mentionPicker.js';

export interface SyncedBlockOps {
  /** F3 — the mirror's state and the source's rows, resolved host-side. */
  readSynced: (blockId: string) => Promise<SyncedReadDto | null>;
  /** E5 — the same candidates the `@` picker offers. */
  searchMentions: (query: string) => Promise<MentionCandidate[]>;
  /** The address IS the mirror's text, so pointing it somewhere is one write. */
  setText: (id: string, text: string) => void;
  openRef: (uri: string) => void;
}

export function SyncedBlock({ blockId, text, readOnly, ops }: {
  blockId: string;
  text: string;
  readOnly: boolean;
  ops: SyncedBlockOps;
}): React.ReactElement {
  const [state, setState] = useState<SyncedReadDto | null>(null);
  const [picking, setPicking] = useState(false);
  const uri = (text ?? '').trim();

  useEffect(() => {
    setState(null);
    if (uri.length === 0) return;
    let cancelled = false;
    void ops.readSynced(blockId).then((next) => {
      if (cancelled) return;
      // A host that could not answer is not "the block was deleted": saying so
      // would accuse somebody of a delete that never happened, which is the same
      // mistake A3 rules out for an embed.
      setState(next ?? {
        status: 'gone', uri, rows: [],
        note: 'The original could not be read here just now.',
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, uri]);

  if (uri.length === 0 || picking) {
    return (
      <div className="notes-synced is-empty">
        {readOnly ? (
          <span className="notes-synced-note">Another device is editing this block.</span>
        ) : (
          <>
            <span className="notes-synced-note">{SYNCED_EMPTY_INVITATION}</span>
            <SyncedPicker
              search={ops.searchMentions}
              onPick={(picked) => { ops.setText(blockId, picked); setPicking(false); }}
            />
          </>
        )}
      </div>
    );
  }

  const ready = state?.status === 'ready';
  return (
    <div className="notes-synced" data-status={state?.status ?? 'loading'}>
      {ready ? (
        <div className="notes-synced-body">
          {state!.rows.map((row) => (
            <SyncedRow key={row.id} row={row} readOnly={readOnly} onText={ops.setText} />
          ))}
          {state!.rows.length === 0 ? (
            <span className="notes-synced-note">The original has nothing in it yet.</span>
          ) : null}
        </div>
      ) : (
        // The sentence, not a blank. Every non-ready state has one and it is
        // core's, so the desktop, the dashboard and an export agree.
        <div className="notes-synced-state">{syncedFooter(state)}</div>
      )}

      <div className="notes-synced-foot">
        <button className="notes-synced-source" onClick={() => ops.openRef(state?.uri || uri)} title={state?.uri || uri}>
          <Icon name="link" size={11} /> {ready ? syncedFooter(state) : 'Open the original'}
        </button>
        {readOnly ? null : (
          <button className="notes-synced-btn" onClick={() => setPicking(true)}>
            <Icon name="edit" size={11} /> Show a different block
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One mirrored row.
 *
 * The editor is bound to `row.id` — the SOURCE's id — which is the whole of
 * "editing either place edits the one block". It is deliberately the plain
 * editor with no structural gestures wired: splitting a mirrored line would be a
 * structural edit to a page the person is not looking at, and F4's undo stack is
 * per page, so the ⌘Z for it would be on a page they cannot see.
 */
function SyncedRow({ row, readOnly, onText }: {
  row: SyncedRowDto;
  readOnly: boolean;
  onText: (id: string, text: string) => void;
}): React.ReactElement {
  const marker = syncedMarker(row);
  const locked = readOnly || row.lockedBy !== null;
  return (
    <div className="notes-synced-row" data-kind={row.kind} style={{ paddingLeft: syncedIndent(row.depth) }}>
      {row.icon ? <span className="notes-synced-icon" aria-hidden="true">{row.icon}</span> : null}
      {marker ? <span className="notes-marker" aria-hidden="true">{marker}</span> : null}
      {row.kind === 'divider' ? <hr className="notes-divider" /> : null}
      {syncedRowIsProse(row.kind) ? (
        <BlockEditor
          blockId={row.id}
          text={row.text}
          kind={row.kind}
          level={row.level}
          readOnly={locked}
          placeholder={placeholderFor(row.kind)}
          refLabels={{}}
          onOpenRef={() => {}}
          onText={(next) => onText(row.id, next)}
          onIntent={() => {}}
          onFocus={() => {}}
          onBlur={() => {}}
          onInputRule={async () => null}
          onRuleTransform={() => {}}
          searchSlash={async () => []}
          searchMentions={async () => []}
          onSlashPlan={() => {}}
          focusRequest={null}
          onPageHistory={() => {}}
        />
      ) : row.kind === 'divider' ? null : (
        // A picture, a bookmark or a table inside a mirror shows its address
        // rather than a second surface bound to a block on another page: those
        // surfaces own a write path, and opening a second one here is how two
        // places start disagreeing about one block.
        <span className="notes-synced-address" title={row.text}>{row.text}</span>
      )}
      {row.lockedBy ? <span className="notes-synced-locked">{row.lockedBy}</span> : null}
    </div>
  );
}

/** The source picker — the `@` candidates, so a mirror addresses what a mention can. */
function SyncedPicker({ search, onPick }: {
  search: (query: string) => Promise<MentionCandidate[]>;
  onPick: (uri: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MentionCandidate[]>([]);

  useEffect(() => {
    let cancelled = false;
    void search(query).then((next) => { if (!cancelled) setRows(next.slice(0, 8)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="notes-synced-picker">
      <input
        className="filter" autoFocus placeholder="Which block?"
        value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && query.trim().startsWith('brainrouter://')) onPick(query.trim());
        }}
      />
      {rows.map((row) => (
        <button key={row.uri} className="notes-synced-row-pick" onClick={() => onPick(row.uri)}>
          <span>{row.label}</span>
          <small>{row.mode}</small>
        </button>
      ))}
      {rows.length === 0 ? (
        <span className="notes-synced-note">Nothing matches. A brainrouter:// address works too.</span>
      ) : null}
    </div>
  );
}
