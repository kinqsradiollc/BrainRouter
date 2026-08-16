/**
 * ADR-029 F3 — save this page as a template, and start a page from one.
 *
 * Both halves in one control, because they are one idea and separating them is
 * how a person ends up able to mark a template and unable to find it again.
 *
 * The COPY is core's (`instantiateTemplate`), including the rule about
 * references inside a template and the sentence explaining it. This component
 * shows that sentence rather than composing its own: the rewrite is a behaviour
 * of the store, and a surface that described it in its own words would keep
 * describing it after the store stopped doing it.
 */
import React, { useCallback, useState } from 'react';
import { Icon } from './Icon.js';
import {
  canBeTemplate, instantiationNote, templateActionLabel, templateRowHint, templatesEmptyNote,
  type TemplateRowDto,
} from './templates.js';
import type { NoteBlockView } from './notesView.js';
import type { NotesOps } from './NotesMode.js';

export function TemplatePicker({ page, pageId, ops, onOpenPage }: {
  /** The open page, or null at the top level (which is a real page, B4). */
  page: NoteBlockView | null;
  pageId: string | null;
  ops: NotesOps;
  onOpenPage: (pageId: string | null) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TemplateRowDto[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void ops.listTemplates().then(setRows).catch(() => setRows([]));
  }, [ops]);

  const markable = page !== null && canBeTemplate(page.kind);

  return (
    <div className="notes-templates">
      <button
        className="notes-icon-btn"
        title="Templates"
        aria-label="Templates"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) load();
        }}
      >
        <Icon name="copy" size={12} />
      </button>

      {open ? (
        <div className="notes-template-menu">
          {markable ? (
            <button
              className="notes-template-mark"
              onClick={() => {
                ops.setTemplate(page.id, !page.template);
                setOpen(false);
              }}
            >
              {templateActionLabel(page.template)}
            </button>
          ) : null}

          <div className="notes-template-list">
            {rows === null ? <span className="notes-template-empty">Reading your templates…</span> : null}
            {rows?.length === 0 ? <span className="notes-template-empty">{templatesEmptyNote()}</span> : null}
            {(rows ?? []).map((row) => (
              <button
                key={row.id}
                className="notes-template-row"
                onClick={() => {
                  void ops.instantiateTemplate(row.id, pageId).then((line) => {
                    // Said out loud: a person who wrote the links inside the
                    // template needs to know they now point at the copy, and one
                    // who expected them to keep pointing at the template needs to
                    // know they do not.
                    setNote(instantiationNote(line));
                    setOpen(false);
                  });
                }}
              >
                <span className="notes-template-icon">{row.icon ?? <Icon name="note" size={12} />}</span>
                <span className="notes-template-title">{row.title}</span>
                <small className="notes-template-hint">{templateRowHint(row)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {note ? (
        <div className="notes-template-note" role="status">
          <span>{note}</span>
          <button onClick={() => { setNote(null); onOpenPage(pageId); }}>Dismiss</button>
        </div>
      ) : null}
    </div>
  );
}
