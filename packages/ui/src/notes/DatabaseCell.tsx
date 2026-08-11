/**
 * ADR-029 E3 — one cell, and the editor its property type gets.
 *
 * **Nothing here coerces.** `coercePropertyValue` runs once, at the write, in
 * core — so a number typed as text, a date typed as a word and a half-URI in a
 * relation all become what they are on the way in, in the one place that decides
 * it. A renderer that parsed first would give a second answer, and the two would
 * disagree about a cell nobody could see the difference in until they filtered
 * on it.
 *
 * **A text-shaped cell commits on blur or Enter, never per keystroke.** Every
 * write is a stamped edit in the per-block outbox (D2) that syncs, so typing a
 * title a character at a time would push one operation per character and put
 * every intermediate spelling on every other device.
 *
 * **A cell this build cannot evaluate is read-only**, showing core's `display`
 * string. §3's argument about formulas is that a column this version cannot
 * compute must appear as exactly that; an editable field over a value we do not
 * understand would let someone overwrite it with one we do.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.js';
import { RefChip } from './ReferenceChip.js';
import {
  cellDayKey, cellEditorFor, monthGrid, monthAnchorOf, selectOptionId, shiftMonth,
  todayKey, toggleMultiValue, valueList, monthLabel, WEEKDAY_LABELS,
  type CellEditor, type DatabasePropertyDto, type NoteFileDto, type NotePropertyValue,
  type NoteSelectOption,
} from './database.js';
import type { MentionCandidate } from './mentionPicker.js';

export interface DatabaseCellProps {
  property: DatabasePropertyDto;
  value: NotePropertyValue;
  /** Core's one-line rendering. Shown wherever this file does not draw its own. */
  display: string;
  /**
   * F2 — why a computed cell has no value.
   *
   * Rendered IN the cell rather than in the notice strip above the view, because
   * that is where the person reading the number is looking. A formula that
   * cannot be worked out on three rows out of forty has nothing to say at the
   * top of the table; it has something to say in those three cells.
   */
  error?: string;
  /** A3 — resolved labels for the references a relation cell holds. */
  refLabels: Record<string, string>;
  onWrite: (value: NotePropertyValue) => void;
  /** Adding an option to a select is a schema edit, so it goes back separately. */
  onAddOption: (option: NoteSelectOption) => void;
  /** E5 — what a relation can address: every mode, not only another page. */
  searchRefs: (query: string) => Promise<MentionCandidate[]>;
  onOpenRef: (uri: string) => void;
  /** The title cell is the row's name and doubles as the link to its page. */
  onOpenRow?: () => void;
  /** Compact cells sit in a table row; roomy ones sit in a card or a filter. */
  variant?: 'cell' | 'field';
  /** F3/D3 — a file into the one attachment store, and the names behind the ids. */
  onAttachFile?: (name: string, dataBase64: string) => Promise<{ ok: boolean; ref?: string; error?: string }>;
  describeFiles?: (ids: readonly string[]) => Promise<NoteFileDto[]>;
}

export function DatabaseCell(props: DatabaseCellProps): React.ReactElement {
  const editor = cellEditorFor(props.property);
  const className = `db-cell db-cell-${editor}${props.variant === 'field' ? ' is-field' : ''}`;

  return (
    <div className={className} data-property={props.property.id}>
      <CellEditorFor {...props} editor={editor} />
    </div>
  );
}

/**
 * The editor for a value, split out so the filter builder can use one without a
 * cell around it — a rule's value and a row's value are the same question asked
 * of the same property, and two editors would accept different things.
 */
export function CellEditorFor(props: DatabaseCellProps & { editor: CellEditor }): React.ReactElement {
  const { property, value, display, editor, onWrite } = props;

  if (editor === 'none') {
    return (
      <span className="db-cell-static" title={`This version cannot read a ${property.type} property.`}>
        {display || '—'}
      </span>
    );
  }

  // F2/F3 — worked out from the row, so there is nothing to type into. An
  // editable field over a derived value would let somebody overwrite a
  // derivation, and core refuses the write anyway: the cell would swallow the
  // typing on blur and look broken.
  if (editor === 'computed') {
    if (props.error) {
      return (
        <span className="db-cell-static is-error" title={props.error}>{props.error}</span>
      );
    }
    return (
      <span
        className="db-cell-static is-computed"
        title={`“${property.name}” is worked out from this row.`}
      >
        {display || '—'}
      </span>
    );
  }

  if (editor === 'files') return <FilesValue {...props} />;

  if (editor === 'checkbox') {
    return (
      <input
        type="checkbox"
        className="db-check"
        checked={value === true}
        aria-label={property.name}
        onChange={(event) => onWrite(event.target.checked)}
      />
    );
  }

  if (editor === 'title') {
    return (
      <div className="db-title-cell">
        <TextValue
          value={typeof value === 'string' ? value : ''}
          placeholder="Untitled"
          onCommit={(next) => onWrite(next)}
        />
        {props.onOpenRow ? (
          // E3 — a row IS a page, so every row has a way to open it. Without
          // this the page a row is would exist and be unreachable.
          <button className="db-open-row" title="Open this row as a page" onClick={props.onOpenRow}>
            <Icon name="chev-right" size={11} />
          </button>
        ) : null}
      </div>
    );
  }

  if (editor === 'text' || editor === 'url') {
    return (
      <TextValue
        value={typeof value === 'string' ? value : ''}
        placeholder={editor === 'url' ? 'https://…' : 'Empty'}
        onCommit={(next) => onWrite(next || null)}
      />
    );
  }

  if (editor === 'number') {
    return (
      <TextValue
        value={typeof value === 'number' ? String(value) : ''}
        placeholder="0"
        numeric
        onCommit={(next) => onWrite(next.trim() === '' ? null : next)}
      />
    );
  }

  if (editor === 'date') return <DateValue {...props} />;
  if (editor === 'select' || editor === 'multi-select') return <SelectValue {...props} multi={editor === 'multi-select'} />;
  if (editor === 'person') return <ListValue {...props} />;
  return <RelationValue {...props} />;
}

/* ------------------------------------------------------------------ files */

/**
 * F3/D3 — a cell holding attachment references, drawn as the files they name.
 *
 * The cell stores `attachment:<id>` and NOT a filename, because D3 says the
 * object is stored once and shared: a name belongs to the record, so it is
 * resolved here rather than copied into every cell that points at the object.
 * The cost is one round trip per cell, and the alternative is a name that goes
 * stale the moment the file is replaced.
 *
 * A reference this workspace does not hold is shown as MISSING with its id
 * rather than dropped — notes are user-scoped (D1) while attachments are per
 * workspace, so a note opened from a different checkout legitimately has files
 * whose bytes are elsewhere, and a shorter list would read as deletion.
 */
function FilesValue({ value, onWrite, onAttachFile, describeFiles }: DatabaseCellProps): React.ReactElement {
  const refs = valueList(value);
  const [files, setFiles] = useState<NoteFileDto[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const ids = refs.map((ref) => ref.replace(/^attachment:/, '')).join('\u0000');
  useEffect(() => {
    if (!describeFiles || ids.length === 0) { setFiles([]); return; }
    let cancelled = false;
    void describeFiles(ids.split('\u0000'))
      .then((rows) => { if (!cancelled) setFiles(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ids, describeFiles]);

  const add = async (picked: FileList | null): Promise<void> => {
    if (!picked || !onAttachFile) return;
    setProblem(null);
    const added: string[] = [];
    for (const file of Array.from(picked).slice(0, 8)) {
      const buffer = await file.arrayBuffer();
      // Chunked, because `String.fromCharCode(...bytes)` on a multi-megabyte
      // file is an argument list long enough to overflow the call stack — the
      // failure looks like the picker doing nothing at all.
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let at = 0; at < bytes.length; at += 8192) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      }
      const stored = await onAttachFile(file.name, btoa(binary));
      if (stored.ok && stored.ref) added.push(stored.ref);
      else setProblem(stored.error ?? 'That file could not be stored.');
    }
    if (added.length > 0) onWrite([...refs, ...added]);
  };

  return (
    <div className="db-files">
      {refs.map((ref, index) => {
        const record = files[index];
        return (
          <span key={ref} className={`db-tag${record?.missing ? ' is-missing' : ''}`}>
            {record?.missing
              ? <span title="This file was added from a different workspace, or it has been deleted.">Missing file</span>
              : record?.name ?? '…'}
            <button
              className="db-file-drop"
              aria-label="Take this file out of the cell"
              title="Take this file out of the cell. The stored file is not deleted."
              onClick={() => onWrite(refs.filter((entry) => entry !== ref).length > 0
                ? refs.filter((entry) => entry !== ref)
                : null)}
            >
              ×
            </button>
          </span>
        );
      })}
      {onAttachFile ? (
        <>
          <button className="db-chip-btn db-relation-add" onClick={() => input.current?.click()}>
            {refs.length === 0 ? <span className="db-empty">Add a file</span> : <Icon name="plus" size={10} />}
          </button>
          <input
            ref={input}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => { void add(event.target.files); event.target.value = ''; }}
          />
        </>
      ) : null}
      {problem ? <span className="db-cell-problem">{problem}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- text */

/**
 * A field that commits on blur or Enter.
 *
 * Escape restores what was stored rather than committing the draft: the person
 * who started typing in the wrong cell needs a way out that does not write, and
 * blurring is not it because they will click somewhere else to leave.
 */
function TextValue({ value, placeholder, numeric, onCommit }: {
  value: string;
  placeholder: string;
  numeric?: boolean;
  onCommit: (value: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  // A value that changed underneath — a sync, or another surface — replaces the
  // draft only while nobody is typing into it.
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);

  return (
    <input
      className="db-input"
      value={draft}
      placeholder={placeholder}
      inputMode={numeric ? 'decimal' : undefined}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { editing.current = false; if (draft !== value) onCommit(draft); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.currentTarget.blur(); return; }
        if (event.key === 'Escape') { setDraft(value); editing.current = false; event.currentTarget.blur(); }
      }}
    />
  );
}

/* ------------------------------------------------------------------- date */

function DateValue(props: DatabaseCellProps): React.ReactElement {
  const popover = usePopoverAnchor();
  const day = cellDayKey(props.value);
  const [anchor, setAnchor] = useState(() => monthAnchorOf(day ?? todayKey()));

  return (
    <>
      <button
        className="db-chip-btn"
        onClick={(event) => { setAnchor(monthAnchorOf(day ?? todayKey())); popover.openFrom(event); }}
      >
        {props.display || <span className="db-empty">Empty</span>}
      </button>
      {popover.rect ? (
        <Popover anchor={popover.rect} onClose={popover.close}>
          <div className="db-cal-head">
            <button className="db-icon-btn" aria-label="Previous month" onClick={() => setAnchor(shiftMonth(anchor, -1))}>
              <Icon name="chev-left" size={12} />
            </button>
            <span className="db-cal-title">{monthLabel(anchor)}</span>
            <button className="db-icon-btn" aria-label="Next month" onClick={() => setAnchor(shiftMonth(anchor, 1))}>
              <Icon name="chev-right" size={12} />
            </button>
          </div>
          <div className="db-cal-grid db-cal-picker">
            {WEEKDAY_LABELS.map((label) => <span key={label} className="db-cal-weekday">{label}</span>)}
            {monthGrid(anchor).flat().map((cell) => (
              <button
                key={cell.key}
                className={`db-cal-day${cell.inMonth ? '' : ' is-outside'}${cell.key === day ? ' is-picked' : ''}${cell.key === todayKey() ? ' is-today' : ''}`}
                onClick={() => { props.onWrite(cell.key); popover.close(); }}
              >
                {cell.day}
              </button>
            ))}
          </div>
          {day ? (
            <button className="db-popover-clear" onClick={() => { props.onWrite(null); popover.close(); }}>
              Clear the date
            </button>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- select */

function SelectValue({ property, value, onWrite, onAddOption, multi }: DatabaseCellProps & { multi: boolean }): React.ReactElement {
  const popover = usePopoverAnchor();
  const [draft, setDraft] = useState('');
  const chosen = valueList(value);
  const options = property.options ?? [];
  const labelOf = (id: string): string => options.find((option) => option.id === id)?.label ?? id;

  const add = (): void => {
    const label = draft.trim();
    if (!label) return;
    const existing = options.find((option) => option.label.toLowerCase() === label.toLowerCase());
    const option = existing ?? { id: selectOptionId(label, new Set(options.map((o) => o.id))), label };
    if (!existing) onAddOption(option);
    onWrite(multi ? toggleMultiValue(value, option.id) : option.id);
    setDraft('');
    if (!multi) popover.close();
  };

  return (
    <>
      <button className="db-chip-btn" onClick={popover.openFrom}>
        {chosen.length === 0 ? <span className="db-empty">Empty</span> : chosen.map((id) => (
          <span key={id} className="db-tag">{labelOf(id)}</span>
        ))}
      </button>
      {popover.rect ? (
        <Popover anchor={popover.rect} onClose={popover.close}>
          <input
            className="filter db-popover-input"
            autoFocus
            placeholder={multi ? 'Find or add options' : 'Find or add an option'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') add(); }}
          />
          <div className="db-option-list">
            {options
              .filter((option) => option.label.toLowerCase().includes(draft.trim().toLowerCase()))
              .map((option) => (
                <button
                  key={option.id}
                  className={`db-option${chosen.includes(option.id) ? ' is-on' : ''}`}
                  onClick={() => {
                    onWrite(multi ? toggleMultiValue(value, option.id) : option.id);
                    if (!multi) popover.close();
                  }}
                >
                  <span className="db-option-check">{chosen.includes(option.id) ? '✓' : ''}</span>
                  <span className="db-tag">{option.label}</span>
                </button>
              ))}
            {/* Typing a name that is not an option yet ADDS it, because the
                alternative is leaving the schema editor as the only way to put a
                word in a column — which is where people stop using the column. */}
            {draft.trim() && !options.some((option) => option.label.toLowerCase() === draft.trim().toLowerCase()) ? (
              <button className="db-option" onClick={add}>
                <span className="db-option-check">+</span>
                <span className="db-tag">{draft.trim()}</span>
              </button>
            ) : null}
          </div>
          {chosen.length > 0 ? (
            <button className="db-popover-clear" onClick={() => { onWrite(null); popover.close(); }}>Clear</button>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- person */

/** A free list of names. Core coerces it to a bounded, de-duplicated string list. */
function ListValue({ value, onWrite }: DatabaseCellProps): React.ReactElement {
  const popover = usePopoverAnchor();
  const [draft, setDraft] = useState('');
  const entries = valueList(value);

  return (
    <>
      <button className="db-chip-btn" onClick={popover.openFrom}>
        {entries.length === 0 ? <span className="db-empty">Empty</span> : entries.map((entry) => (
          <span key={entry} className="db-tag">{entry}</span>
        ))}
      </button>
      {popover.rect ? (
        <Popover anchor={popover.rect} onClose={popover.close}>
          <input
            className="filter db-popover-input" autoFocus placeholder="Add a name" value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !draft.trim()) return;
              onWrite(toggleMultiValue(value, draft.trim()));
              setDraft('');
            }}
          />
          <div className="db-option-list">
            {entries.map((entry) => (
              <button key={entry} className="db-option is-on" onClick={() => onWrite(toggleMultiValue(value, entry))}>
                <span className="db-option-check">✓</span>
                <span className="db-tag">{entry}</span>
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- relation */

/**
 * E5 — a relation cell holds Part A URIs, so it can cite a planner item, a work
 * item, a meeting or another page.
 *
 * The picker writes the reference the same way the `@` menu does, from the same
 * candidate list, so a row can address anything a paragraph can. The chip is the
 * shared one, and its label is RESOLVED (A3) rather than stored beside the link.
 */
function RelationValue({ value, refLabels, onWrite, searchRefs, onOpenRef }: DatabaseCellProps): React.ReactElement {
  const popover = usePopoverAnchor();
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const uris = valueList(value);
  const picking = popover.rect !== null;

  useEffect(() => {
    if (!picking) return;
    let cancelled = false;
    void searchRefs(query).then((rows) => { if (!cancelled) setCandidates(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [picking, query, searchRefs]);

  return (
    <>
      <div className="db-relation">
        {uris.map((uri) => <RefChip key={uri} uri={uri} label={refLabels[uri]} onOpen={onOpenRef} />)}
        <button className="db-chip-btn db-relation-add" onClick={popover.openFrom}>
          {uris.length === 0 ? <span className="db-empty">Link something</span> : <Icon name="plus" size={10} />}
        </button>
      </div>
      {picking ? (
        <Popover anchor={popover.rect} onClose={popover.close}>
          <input
            className="filter db-popover-input" autoFocus placeholder="Search the whole workspace"
            value={query} onChange={(event) => setQuery(event.target.value)}
          />
          <div className="db-option-list">
            {candidates.map((candidate) => (
              <button
                key={candidate.uri}
                className={`db-option${uris.includes(candidate.uri) ? ' is-on' : ''}`}
                onClick={() => onWrite(toggleMultiValue(value, candidate.uri))}
              >
                <span className="db-option-check">{uris.includes(candidate.uri) ? '✓' : ''}</span>
                <span className="db-option-label">{candidate.label}</span>
                <span className="db-option-mode">{candidate.mode}</span>
              </button>
            ))}
            {candidates.length === 0 ? <span className="db-popover-empty">Nothing matches.</span> : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- popover */

/**
 * The control a popover hangs under, captured when it is opened.
 *
 * The rect is taken from the CLICKED element rather than looked up afterwards:
 * `document.activeElement` is the obvious shortcut and it is wrong often enough
 * to matter — a programmatic click never moves focus, and a menu that then
 * anchors to `<body>` opens in the corner of the window with no relationship to
 * the thing it belongs to.
 *
 * `rect === null` IS "closed", so there is one piece of state rather than a
 * boolean and a rect that can disagree about whether a menu is open.
 */
export function usePopoverAnchor(): {
  rect: DOMRect | null;
  openFrom: (event: React.MouseEvent<HTMLElement>) => void;
  close: () => void;
} {
  const [rect, setRect] = useState<DOMRect | null>(null);
  return {
    rect,
    openFrom: (event) => setRect(event.currentTarget.getBoundingClientRect()),
    close: () => setRect(null),
  };
}

/**
 * Portaled to `<body>`, and positioned under the control that opened it.
 *
 * A table scrolls in both directions, so an absolutely-positioned menu is
 * clipped by the first ancestor with `overflow` — the same reason the page
 * header portals its pickers, and the same reason a native `<select>` is
 * unusable in this app.
 */
export function Popover({ anchor, children, onClose }: {
  anchor: DOMRect | null;
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      // A popover opened FROM this one — a filter rule's value picker — is a
      // sibling in the DOM because both are portaled to `<body>`. Closing on a
      // click inside it would take the filter builder down the instant someone
      // picked the value they opened it to pick.
      if (target.closest?.('.db-popover')) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    // Deferred a tick: the click that OPENED this is still propagating, and a
    // listener added synchronously catches it and closes immediately.
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const style = useMemo((): React.CSSProperties => {
    // No anchor is possible when a caller opens one without a click to measure.
    // Centred rather than at the origin, so it is at least readable.
    if (!anchor) return { position: 'fixed', left: '50%', top: '20%', transform: 'translateX(-50%)' };
    const width = 260;
    const height = 320;
    // Flipped up or pulled left rather than allowed off-screen: a menu whose
    // options are past the window edge is a menu with fewer options.
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const below = window.innerHeight - anchor.bottom;
    return below < height && anchor.top > below
      ? { position: 'fixed', left, bottom: window.innerHeight - anchor.top + 4, width }
      : { position: 'fixed', left, top: anchor.bottom + 4, width };
  }, [anchor]);

  return createPortal(<div className="db-popover" ref={ref} style={style}>{children}</div>, document.body);
}
