/**
 * ADR-029 Part B — the Notes mode.
 *
 * A sixth workspace mode beside Chat · Code · Track · Meetings · Planner. Notes
 * are user-scoped and cross-project (D1), so like the planner this is a MODE
 * rather than a panel: panels are bound to one workspace and one session, and
 * putting a cross-workspace surface inside a workspace-scoped container is the
 * scoping error ADR-028 D9 recorded.
 *
 * The unit is a block (B1) and a page is a block with children (B4), so the
 * whole document is one recursion rendered flat with an indent.
 *
 * This component renders. Every judgement — what is editable and why, what a
 * placeholder says, which cross-mode moves a line offers — comes from
 * `notesView`.
 */
import React, { useMemo, useState } from 'react';
import { Icon } from '../icons.js';
import { Button } from '../components/primitives/Button.js';
import {
  backlinkNote, canEdit, conflictBanner, emptyMessage, indentFor, pendingRefLabel,
  placeholderFor, readOnlyReason, repairNote, sendTargetsFor, visibleBlocks,
  type NoteBlockView, type NoteSendTarget, type NoteTreeRepairView,
} from '../lib/notes/notesView.js';

export interface NotesOps {
  addBlock: (afterId: string | null, kind?: string) => void;
  addPage: () => void;
  setText: (id: string, text: string) => void;
  setKind: (id: string, kind: string) => void;
  toggleChecked: (id: string, checked: boolean) => void;
  deleteBlock: (id: string) => void;
  /** Tab / Shift-Tab. B4's nesting is the same recursion as a sub-page. */
  indent: (id: string) => void;
  outdent: (id: string) => void;
  /** B2 — take the lease on focus, drop it on blur. */
  beginEdit: (id: string) => void;
  endEdit: (id: string) => void;
  resolveConflict: (id: string, field: string, keep: 'ours' | 'theirs') => void;
  /** C2 — a line becomes a work item or a planner task, and cites it back. */
  sendTo: (id: string, target: NoteSendTarget) => void;
  /** C2 — Notes → Code: cite a file from a note. */
  linkFile: (id: string, relPath: string) => void;
  /** Follow a reference to whatever it addresses. */
  openRef: (uri: string) => void;
  /** B5 — the ranked search, which lives in core and is asked for by id. */
  search: (query: string) => void;
  /** A2 — what links to this block. Asked for when the menu opens, not before. */
  loadBacklinks: (id: string) => void;
}

export function NotesMode({
  blocks, repairs, syncState, refLabels, files, matchIds, backlinkCounts, ops,
}: {
  blocks: NoteBlockView[];
  repairs: NoteTreeRepairView[];
  syncState: string;
  /** A3 — resolved labels, read now rather than stored on the link. */
  refLabels: Record<string, string>;
  /** Workspace-relative paths offered by the file picker. */
  files: string[];
  /** B5's hits by block id, or null when nothing has been searched for. */
  matchIds: ReadonlySet<string> | null;
  backlinkCounts: Record<string, number>;
  ops: NotesOps;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const visible = useMemo(() => visibleBlocks(blocks, matchIds), [blocks, matchIds]);
  const banner = conflictBanner(blocks);

  return (
    <div className="notes-mode">
      <header className="notes-head">
        <div className="notes-actions">
          <Button variant="primary" onClick={() => ops.addPage()}>
            <Icon name="plus" size={12} /> New page
          </Button>
          <input className="filter notes-filter" placeholder="Search notes and what they link to"
            value={query} onChange={(e) => { setQuery(e.target.value); ops.search(e.target.value); }} />
        </div>
        {/* Sync runs on its own (B3/D2). The line reports state as a fact;
            offline is the normal mode that happens to be syncing. */}
        <span className="notes-sync">{syncState}</span>
      </header>

      {banner ? <div className="notes-conflict-banner">{banner}</div> : null}

      {repairs.map((repair) => (
        <div key={repair.blockId} className="notes-repair">{repairNote(repair)}</div>
      ))}

      <div className="notes-body scroll">
        {visible.length === 0 ? (
          <p className="notes-empty">{query ? 'Nothing matches.' : emptyMessage()}</p>
        ) : null}

        {visible.map((block) => (
          <BlockRow
            key={block.id} block={block} refLabels={refLabels} ops={ops}
            backlinkCount={backlinkCounts[block.id] ?? 0}
            menuOpen={menuFor === block.id}
            onMenu={() => {
              const opening = menuFor !== block.id;
              setMenuFor(opening ? block.id : null);
              if (opening) ops.loadBacklinks(block.id);
            }}
            linkOpen={linkFor === block.id}
            onLink={() => { setLinkFor(linkFor === block.id ? null : block.id); setMenuFor(null); }}
            files={files}
          />
        ))}

        {visible.length > 0 ? (
          <button className="notes-add-line" onClick={() => ops.addBlock(null)}>
            <Icon name="plus" size={11} /> Add a line
          </button>
        ) : (
          <button className="notes-add-line" onClick={() => ops.addBlock(null)}>
            <Icon name="plus" size={11} /> Write the first line
          </button>
        )}
      </div>
    </div>
  );
}

function BlockRow({
  block, refLabels, ops, backlinkCount, menuOpen, onMenu, linkOpen, onLink, files,
}: {
  block: NoteBlockView;
  refLabels: Record<string, string>;
  ops: NotesOps;
  /** A2 — how many blocks link HERE, computed from their text, not stored here. */
  backlinkCount: number;
  menuOpen: boolean;
  onMenu: () => void;
  linkOpen: boolean;
  onLink: () => void;
  files: string[];
}): React.ReactElement {
  const locked = readOnlyReason(block);
  const editable = canEdit(block);
  const targets = sendTargetsFor(block);

  return (
    <div className="notes-block" data-kind={block.kind} style={{ paddingLeft: indentFor(block.depth) }}>
      <div className="notes-block-main">
        {block.kind === 'todo' ? (
          <input type="checkbox" checked={block.checked} disabled={!editable}
            aria-label="Done" onChange={(e) => ops.toggleChecked(block.id, e.target.checked)} />
        ) : null}

        {block.kind === 'divider' ? (
          <hr className="notes-divider" />
        ) : (
          <textarea
            className={`notes-text notes-text-${block.kind}`}
            rows={1}
            value={block.text}
            readOnly={!editable}
            placeholder={placeholderFor(block.kind)}
            onFocus={() => ops.beginEdit(block.id)}
            onBlur={() => ops.endEdit(block.id)}
            onChange={(e) => ops.setText(block.id, e.target.value)}
            onKeyDown={(e) => {
              // Enter makes the next line, Tab nests it. The two gestures an
              // outliner is: anything else is a menu, and a menu is not typing.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ops.addBlock(block.id); }
              if (e.key === 'Tab') { e.preventDefault(); e.shiftKey ? ops.outdent(block.id) : ops.indent(block.id); }
            }}
          />
        )}

        <div className="notes-block-tools">
          <button className="notes-icon-btn" title="Link a file" aria-label="Link a file" onClick={onLink}>
            <Icon name="link" size={12} />
          </button>
          <button className="notes-icon-btn" title="Block actions" aria-label="Block actions" onClick={onMenu}>
            <Icon name="dots" size={12} />
          </button>
        </div>
      </div>

      {/* B2 — read-only WITH an attribution. A silently disabled field reads as
          the app being broken; naming the other device is what makes the block
          being locked information rather than a fault. */}
      {locked ? <div className="notes-locked">{locked}</div> : null}

      {block.refs.length > 0 ? (
        <div className="notes-refs">
          {block.refs.map((uri) => (
            // A3 — the chip shows the target's CURRENT state, including
            // "(deleted 4 Aug)". Snapshotting the label at insert time is what
            // produces documents that are quietly wrong.
            <button key={uri} className="notes-ref-chip" title={uri} onClick={() => ops.openRef(uri)}>
              <Icon name="link" size={10} /> {refLabels[uri] ?? pendingRefLabel(uri)}
            </button>
          ))}
        </div>
      ) : null}

      {block.conflictFields.map((field) => (
        <div key={field} className="notes-conflict">
          <span>“{field}” was edited in two places.</span>
          <button onClick={() => ops.resolveConflict(block.id, field, 'ours')}>Keep mine</button>
          <button onClick={() => ops.resolveConflict(block.id, field, 'theirs')}>Keep theirs</button>
        </div>
      ))}

      {linkOpen ? <FilePicker files={files} onPick={(p) => { ops.linkFile(block.id, p); onLink(); }} /> : null}

      {menuOpen ? (
        <div className="notes-menu" role="menu">
          {backlinkNote(backlinkCount) ? (
            <div className="notes-backlinks">{backlinkNote(backlinkCount)}</div>
          ) : null}
          {targets.map((target) => (
            <button key={target.id} role="menuitem" onClick={() => { ops.sendTo(block.id, target); onMenu(); }}>
              {target.label}
            </button>
          ))}
          {(['paragraph', 'heading', 'todo', 'bullet', 'quote', 'code', 'divider'] as const).map((kind) => (
            <button key={kind} role="menuitem" disabled={block.kind === kind}
              onClick={() => { ops.setKind(block.id, kind); onMenu(); }}>
              Turn into {kind}
            </button>
          ))}
          <button role="menuitem" className="danger" onClick={() => { ops.deleteBlock(block.id); onMenu(); }}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * C2's Notes → Code row.
 *
 * A path picked from the workspace rather than typed, because a reference to a
 * file that does not exist resolves as a tombstone and the person who typed the
 * typo has no way to tell that apart from a file someone deleted.
 */
function FilePicker({ files, onPick }: { files: string[]; onPick: (path: string) => void }): React.ReactElement {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (needle ? files.filter((f) => f.toLowerCase().includes(needle)) : files).slice(0, 8);
  }, [files, query]);

  return (
    <div className="notes-linkpicker">
      <input className="filter" autoFocus placeholder="Which file?" value={query}
        onChange={(e) => setQuery(e.target.value)} />
      {matches.map((file) => (
        <button key={file} className="notes-linkpicker-item" onClick={() => onPick(file)}>{file}</button>
      ))}
      {matches.length === 0 ? <span className="notes-linkpicker-empty">No file matches.</span> : null}
    </div>
  );
}
