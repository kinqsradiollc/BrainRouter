/**
 * ADR-029 E1/E4 — one line of a page: the handle, the text, and what hangs off it.
 *
 * Split out of `NotesMode` when the block became an editing surface rather than
 * a textarea. The mode owns the page — which block has the caret, which blocks
 * are selected, what a drag is currently over — because those are properties of
 * the page and not of any one line; the row owns nothing and renders what it is
 * given.
 *
 * B2's lease is the one piece of state a row reads for itself, through
 * `canEdit`: a block another device holds is read-only WITH the attribution
 * under it. That was true of the textarea and it stays true here, because it is
 * the decision the whole lease exists for.
 *
 * **Part F is the routing below.** Every kind the slash menu offers now reaches
 * a renderer from here — a toggle its twisty, a callout its frame, and an image,
 * a bookmark, a table and an embed their own surfaces. F1's whole point is that
 * this switch is where an offered kind either becomes real or quietly falls
 * through to a plain line of text, which is what it used to do for five of them.
 */
import React, { useMemo, useState } from 'react';
import { Icon } from './Icon.js';
import { RefChip } from './ReferenceChip.js';
import { BlockEditor } from './BlockEditor.js';
import { BlockHandle } from './BlockHandle.js';
import { CalloutFrame, ToggleTwisty } from './BlockShells.js';
import { ImageBlock } from './ImageBlock.js';
import { BookmarkBlock } from './BookmarkBlock.js';
import { TableBlock } from './TableBlock.js';
import { EmbedBlock } from './EmbedBlock.js';
import { SyncedBlock } from './SyncedBlock.js';
import { CommentThread } from './CommentThreadView.js';
import { collapsedCount } from './blockVisibility.js';
import { commentBadge } from './commentThread.js';
import {
  backlinkNote, canEdit, conflictLine, indentFor, placeholderFor, readOnlyReason,
  rendersOwnSurface, sendTargetsFor, type NoteBlockView,
} from './notesView.js';
import { dropPositionInRow, moveToTargets, type MoveToTarget, type PageDropPosition } from './blockSelection.js';
import { TOP_LEVEL_LABEL } from './pageTree.js';
import type { BlockIntent } from './blockKeymap.js';
import type { SlashCommandDto, SlashPlan } from './slashMenu.js';
import type { BlockAction } from './blockSelection.js';
import type { NotesOps, CodeSymbolPick } from './NotesMode.js';

export interface BlockRowProps {
  block: NoteBlockView;
  /** Every block on the device, for the moves that need the whole tree. */
  blocks: readonly NoteBlockView[];
  pageId: string | null;
  refLabels: Record<string, string>;
  ops: NotesOps;
  /** Core's slash catalog, loaded once by the mode. */
  commands: readonly SlashCommandDto[];
  backlinkCount: number;
  menuOpen: boolean;
  onMenu: () => void;
  linkOpen: boolean;
  onLink: () => void;
  files: string[];
  symbols: Record<string, CodeSymbolPick[]>;
  /** E4 — part of a multi-block selection, so one action applies to all. */
  selected: boolean;
  selectedCount: number;
  focusRequest: {
    caret: number; token: number; x?: number; edge?: 'first' | 'last'; adopt?: boolean;
  } | null;
  /** F3 — this block's comment thread is showing. */
  commentsOpen: boolean;
  onComments: () => void;
  /** F4 — ⌘Z ran out of typing in this block, so the page's stack takes it. */
  onPageHistory: (direction: 'undo' | 'redo') => void;
  onIntent: (block: NoteBlockView, intent: BlockIntent, at: { text: string; caret: number }) => void;
  onSlashPlan: (block: NoteBlockView, plan: SlashPlan, at: { text: string; caret: number }) => void;
  onAction: (block: NoteBlockView, action: BlockAction) => void;
  onTurnInto: (block: NoteBlockView, command: SlashCommandDto) => void;
  onSelectFrom: (block: NoteBlockView, extend: boolean) => void;
  drag: {
    dragging: boolean;
    hint: PageDropPosition | null;
    onStart: (block: NoteBlockView) => void;
    onEnd: () => void;
    onOver: (block: NoteBlockView, position: PageDropPosition) => void;
    onDrop: (block: NoteBlockView, position: PageDropPosition) => void;
  };
}

export function BlockRow(props: BlockRowProps): React.ReactElement {
  const {
    block, blocks, pageId, refLabels, ops, commands, backlinkCount, menuOpen, onMenu,
    linkOpen, onLink, files, symbols, selected, selectedCount, focusRequest, drag,
    commentsOpen, onComments, onPageHistory,
  } = props;

  const locked = readOnlyReason(block);
  const editable = canEdit(block);
  const targets = sendTargetsFor(block);
  const moveTargets: MoveToTarget[] = useMemo(
    () => moveToTargets(blocks, block.id, pageId, TOP_LEVEL_LABEL),
    [blocks, block.id, pageId],
  );

  // F3 — how much a fold is hiding, so the twisty can say so rather than imply
  // it. Computed from the whole tree because a toggle's subtree can be deeper
  // than the page's own body list.
  const childCount = useMemo(
    () => (block.kind === 'toggle' ? collapsedCount(blocks, block.id) : 0),
    [blocks, block.id, block.kind],
  );

  const className = [
    'notes-block',
    selected ? 'is-selected' : '',
    drag.dragging ? 'is-dragging' : '',
    drag.hint ? `drop-${drag.hint}` : '',
  ].filter(Boolean).join(' ');

  /**
   * The ordinary editing surface, built once.
   *
   * A callout wraps it in a frame and every other prose kind renders it bare —
   * two call sites, one element, so a callout's editor cannot be configured
   * differently from a paragraph's by accident.
   */
  const editor = (
    <BlockEditor
      blockId={block.id}
      text={block.text}
      kind={block.kind}
      level={block.level}
      readOnly={!editable}
      placeholder={placeholderFor(block.kind)}
      refLabels={refLabels}
      onOpenRef={ops.openRef}
      onText={(text) => ops.setText(block.id, text)}
      onIntent={(intent, at) => props.onIntent(block, intent, at)}
      onFocus={() => ops.beginEdit(block.id)}
      onBlur={() => ops.endEdit(block.id)}
      onInputRule={ops.inputRule}
      onRuleTransform={(transform) => ops.applyRule(block.id, transform)}
      searchSlash={ops.searchSlash}
      searchMentions={ops.searchMentions}
      onSlashPlan={(plan, at) => props.onSlashPlan(block, plan, at)}
      focusRequest={focusRequest}
      onPageHistory={onPageHistory}
    />
  );

  // F3 — the marker is drawn from what the block already carries, so it is there
  // before anyone clicks. A badge that appeared only after a round trip is one
  // nobody knows to look for.
  const badge = commentBadge(block.comments);

  return (
    <div
      className={className}
      data-kind={block.kind}
      style={{ paddingLeft: indentFor(block.depth) }}
      onDragOver={(event) => {
        if (!drag.dragging && !event.dataTransfer.types.includes('text/plain')) return;
        event.preventDefault();
        // The page behind this row is a drop target too (it lifts a block out to
        // the page). Letting the event reach it would immediately replace this
        // row's hint with the page's, so the line never appears where the
        // pointer is.
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        drag.onOver(block, dropPositionInRow(event.clientY - rect.top, rect.height));
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        drag.onDrop(block, dropPositionInRow(event.clientY - rect.top, rect.height));
      }}
      // Shift-click extends the selection across blocks; a plain click starts a
      // new one. Mouse DOWN rather than click, so the selection is set before
      // the browser moves the caret into the text.
      onMouseDown={(event) => props.onSelectFrom(block, event.shiftKey)}
    >
      <div className="notes-block-main">
        <BlockHandle
          open={menuOpen}
          onOpen={onMenu}
          onAddBelow={() => void ops.addBlock(block.id)}
          onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id); drag.onStart(block); }}
          onDragEnd={drag.onEnd}
          commands={commands}
          currentKind={block.kind}
          moveTargets={moveTargets}
          onTurnInto={(command) => props.onTurnInto(block, command)}
          onAction={(action) => props.onAction(block, action)}
          onMoveTo={(target) => { ops.moveBlock({ id: block.id, parentId: target.id }); onMenu(); }}
          backlinkNote={backlinkNote(backlinkCount)}
          sendTargets={targets}
          onSendTo={(id) => {
            const target = targets.find((entry) => entry.id === id);
            if (target) ops.sendTo(block.id, target);
            onMenu();
          }}
          selectedCount={selectedCount}
          canCopyLink={Boolean(ops.capabilities.clipboard)}
        />

        {block.kind === 'todo' ? (
          <input type="checkbox" checked={block.checked} disabled={!editable}
            aria-label="Done" onChange={(e) => ops.toggleChecked(block.id, e.target.checked)} />
        ) : null}

        {/* F3 — the toggle's disclosure triangle. What it folds is decided in
            `blockVisibility.ts`, and the page applies it; the row only offers
            the gesture and says how much is under it. */}
        {block.kind === 'toggle' ? (
          <ToggleTwisty
            collapsed={block.collapsed}
            childCount={childCount}
            disabled={!editable}
            onToggle={() => ops.setCollapsed(block.id, !block.collapsed)}
          />
        ) : null}

        {/* E4 — a list looks like a list. The NUMBER comes from core with the
            block (it is a function of tree position), never from counting the
            rows on screen: a filtered page would then number 1, 2, 3 while the
            document says 4, 7, 9. */}
        {block.kind === 'bullet' || block.kind === 'numbered' ? (
          <span className="notes-marker" aria-hidden="true">
            {block.kind === 'bullet' ? '•' : `${block.ordinal ?? 1}.`}
          </span>
        ) : null}

        {block.kind === 'divider' ? <hr className="notes-divider" /> : null}

        {/* F1 — the four kinds whose `text` is an ADDRESS rather than prose. Each
            draws its own surface, because an editor over a URL would offer
            marks, a slash menu and a split to a value that has no use for any
            of them. */}
        {rendersOwnSurface(block.kind) ? (
          <div className="notes-block-surface">
            {block.kind === 'image' ? (
              <ImageBlock blockId={block.id} text={block.text} readOnly={!editable}
                ops={{ images: ops.capabilities.images, setText: ops.setText }} />
            ) : null}
            {block.kind === 'bookmark' ? (
              <BookmarkBlock blockId={block.id} text={block.text} readOnly={!editable}
                ops={{ bookmarks: ops.capabilities.bookmarks, setText: ops.setText }} />
            ) : null}
            {block.kind === 'embed' ? (
              <EmbedBlock blockId={block.id} text={block.text} readOnly={!editable}
                ops={{
                  liveReferences: ops.capabilities.liveReferences,
                  searchMentions: ops.searchMentions,
                  setText: ops.setText,
                  openRef: ops.openRef,
                }} />
            ) : null}
            {block.kind === 'table' ? (
              <TableBlock table={block} blocks={blocks} ops={ops} />
            ) : null}
            {/* F3 — the mirror. Its rows carry the SOURCE's ids, so the editor
                over one writes to the one block; nothing here copies content. */}
            {block.kind === 'synced' ? (
              <SyncedBlock blockId={block.id} text={block.text} readOnly={!editable}
                ops={{
                  liveReferences: ops.capabilities.liveReferences,
                  searchMentions: ops.searchMentions,
                  setText: ops.setText,
                  beginEdit: ops.beginEdit,
                  endEdit: ops.endEdit,
                  openRef: ops.openRef,
                }} />
            ) : null}
          </div>
        ) : null}

        {block.kind !== 'divider' && !rendersOwnSurface(block.kind) ? (
          block.kind === 'callout' ? (
            <CalloutFrame
              icon={block.icon}
              readOnly={!editable}
              onIcon={(glyph) => ops.setIcon(block.id, glyph)}
            >
              {editor}
            </CalloutFrame>
          ) : editor
        ) : null}

        <div className="notes-block-tools">
          {files.length > 0 ? (
            <button className="notes-icon-btn" title="Link a file" aria-label="Link a file" onClick={onLink}>
              <Icon name="link" size={12} />
            </button>
          ) : null}
          {/* F3 — comments on a block. Always offered, because the gesture is
              "say something about this line" and a control that appears only
              once a thread exists cannot start one. */}
          <button
            className={`notes-icon-btn notes-comment-btn${badge ? ' has-comments' : ''}`}
            title={badge ? `Comments — ${badge}` : 'Comment on this line'}
            aria-label="Comments"
            aria-expanded={commentsOpen}
            onClick={onComments}
          >
            <Icon name="bubble" size={12} />
            {badge ? <span className="notes-comment-badge">{badge}</span> : null}
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
            // produces documents that are quietly wrong. The chip itself is the
            // shared one, so the planner cannot render the same reference
            // differently.
            <RefChip key={uri} uri={uri} label={refLabels[uri]} onOpen={ops.openRef} />
          ))}
        </div>
      ) : null}

      {block.conflicts.map((conflict) => (
        <div key={conflict.field} className="notes-conflict">
          <span>{conflictLine(conflict)}</span>
          <button onClick={() => ops.resolveConflict(block.id, conflict.field, 'ours', {
            oursAt: conflict.oursAt,
            theirsAt: conflict.theirsAt,
          })}>Keep mine</button>
          <button onClick={() => ops.resolveConflict(block.id, conflict.field, 'theirs', {
            oursAt: conflict.oursAt,
            theirsAt: conflict.theirsAt,
          })}>Keep theirs</button>
        </div>
      ))}

      {commentsOpen ? (
        <CommentThread blockId={block.id} comments={block.comments} ops={ops} />
      ) : null}

      {linkOpen && files.length > 0 ? (
        <FilePicker
          files={files} symbols={symbols} onLoadSymbols={(p) => ops.loadSymbols(p)}
          onPick={(p, symbol) => { ops.linkFile(block.id, p, symbol); onLink(); }}
        />
      ) : null}
    </div>
  );
}

/**
 * C2's Notes → Code row, in two steps: which file, then which part of it.
 *
 * A path picked from the workspace rather than typed, because a reference to a
 * file that does not exist resolves as a tombstone and the person who typed the
 * typo has no way to tell that apart from a file someone deleted. The SYMBOL is
 * picked for the same reason and from the same evidence: the list is the
 * declarations the resolver itself recognises, so the picker cannot offer a
 * name that resolution will then fail to find.
 */
function FilePicker({ files, symbols, onLoadSymbols, onPick }: {
  files: string[];
  symbols: Record<string, CodeSymbolPick[]>;
  onLoadSymbols: (path: string) => void;
  onPick: (path: string, symbol?: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (needle ? files.filter((f) => f.toLowerCase().includes(needle)) : files).slice(0, 8);
  }, [files, query]);

  if (chosen) {
    // Absent means "not read yet"; an empty array means "read, and it declares
    // nothing this recognises". Collapsing the two would make a slow read look
    // like a file with no functions in it.
    const declared = symbols[chosen];
    return (
      <div className="notes-linkpicker">
        <div className="notes-linkpicker-head">
          <button className="notes-linkpicker-back" onClick={() => setChosen(null)}>← Files</button>
          <span className="notes-linkpicker-path" title={chosen}>{chosen}</span>
        </div>
        <button className="notes-linkpicker-item" onClick={() => onPick(chosen)}>Link the whole file</button>
        {(declared ?? []).map((symbol) => (
          <button key={`${symbol.name}:${symbol.line}`} className="notes-linkpicker-item"
            onClick={() => onPick(chosen, symbol.name)}>
            {symbol.name} <small>{symbol.kind} · line {symbol.line}</small>
          </button>
        ))}
        {declared === undefined ? <span className="notes-linkpicker-empty">Reading its declarations…</span> : null}
        {declared?.length === 0
          ? <span className="notes-linkpicker-empty">Nothing declared here to point at.</span>
          : null}
      </div>
    );
  }

  return (
    <div className="notes-linkpicker">
      <input className="filter" autoFocus placeholder="Which file?" value={query}
        onChange={(e) => setQuery(e.target.value)} />
      {matches.map((file) => (
        <button key={file} className="notes-linkpicker-item"
          onClick={() => { setChosen(file); onLoadSymbols(file); }}>{file}</button>
      ))}
      {matches.length === 0 ? <span className="notes-linkpicker-empty">No file matches.</span> : null}
    </div>
  );
}
