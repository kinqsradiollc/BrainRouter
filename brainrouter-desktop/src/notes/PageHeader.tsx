/**
 * ADR-029 E4 — the page header: cover, icon, title, breadcrumbs.
 *
 * The title is an input over the page block's own `text` (B4/E2), not a second
 * field — so renaming a page is one `notes-update`, and the sidebar row, the
 * breadcrumb and the heading cannot disagree because there is only one value
 * for them to disagree about.
 *
 * The pickers are PORTALED rather than positioned inside the header. The header
 * sits in a scrolling column, so an absolutely-positioned menu is clipped by
 * the first ancestor with `overflow` — which is the same reason a native
 * `<select>` is unusable in this app.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.js';
import {
  coverActionLabel, coverStyle, favouriteActionLabel, iconActionLabel, newPageLabel,
  PAGE_ICON_CHOICES, PAGE_TITLE_PLACEHOLDER, titleFieldValue, type PageHeaderView,
} from '../lib/notes/pageHeader.js';
import { TOP_LEVEL_LABEL } from '../lib/notes/pageTree.js';

export interface PageHeaderOps {
  openPage: (pageId: string | null) => void;
  setPageTitle: (id: string, title: string) => void;
  setIcon: (id: string, icon: string) => void;
  setCover: (id: string, cover: string) => void;
  setFavourite: (id: string, favourite: boolean) => void;
  addPage: (parentId: string | null) => void;
}

export function PageHeader({
  view, block, ops,
}: {
  view: PageHeaderView;
  /** The page block itself, for the title field. Absent at the top level. */
  block: { text: string } | null;
  ops: PageHeaderOps;
}): React.ReactElement {
  const [picker, setPicker] = useState<'icon' | 'cover' | null>(null);
  const cover = coverStyle(view.cover);

  return (
    <header className="notes-page-header">
      {cover ? <div className="notes-cover" style={cover} /> : null}

      {/* Breadcrumbs are the whole navigation up: a sub-page four levels down
          is otherwise reachable only by expanding the tree back to it. */}
      <nav className="notes-crumbs" aria-label="Breadcrumbs">
        <button className="notes-crumb" onClick={() => ops.openPage(null)}>{TOP_LEVEL_LABEL}</button>
        {view.crumbs.map((crumb, index) => (
          <React.Fragment key={crumb.id}>
            <span className="notes-crumb-sep">/</span>
            <button
              className={`notes-crumb${index === view.crumbs.length - 1 ? ' current' : ''}`}
              onClick={() => ops.openPage(crumb.id)}
            >
              {crumb.icon ? <span className="notes-crumb-icon">{crumb.icon}</span> : null}
              {crumb.title}
            </button>
          </React.Fragment>
        ))}
      </nav>

      <div className="notes-title-row">
        {view.editable ? (
          <button className="notes-page-icon" title={iconActionLabel(view.icon)}
            aria-label={iconActionLabel(view.icon)}
            onClick={() => setPicker(picker === 'icon' ? null : 'icon')}>
            {view.icon ?? <Icon name="note" size={18} />}
          </button>
        ) : null}

        {view.editable && block ? (
          <input
            className="notes-title-input"
            value={titleFieldValue(block)}
            placeholder={PAGE_TITLE_PLACEHOLDER}
            aria-label="Page title"
            onChange={(e) => ops.setPageTitle(view.pageId!, e.target.value)}
          />
        ) : (
          <h1 className="notes-title-static">{view.title}</h1>
        )}
      </div>

      <div className="notes-page-tools">
        {view.editable ? (
          <>
            <button className="notes-page-tool" onClick={() => setPicker(picker === 'cover' ? null : 'cover')}>
              <Icon name="chart" size={11} /> {coverActionLabel(view.cover)}
            </button>
            <button className="notes-page-tool"
              onClick={() => ops.setFavourite(view.pageId!, !view.favourite)}>
              <Icon name="pin" size={11} /> {favouriteActionLabel(view.favourite)}
            </button>
          </>
        ) : null}
        <button className="notes-page-tool" onClick={() => ops.addPage(view.pageId)}>
          <Icon name="plus" size={11} /> {newPageLabel(view.editable ? view.title : null)}
        </button>
      </div>

      {picker === 'icon' && view.pageId ? (
        <Popover onClose={() => setPicker(null)}>
          <div className="notes-icon-grid">
            {PAGE_ICON_CHOICES.map((glyph) => (
              <button key={glyph} className="notes-icon-choice"
                onClick={() => { ops.setIcon(view.pageId!, glyph); setPicker(null); }}>{glyph}</button>
            ))}
          </div>
          {/* Any character, not only the palette's — the grid is a shortcut,
              and a picker that refused a glyph someone pasted would be the
              only place in the app where their own text was rejected. */}
          <TextField
            label="Or paste a character" value={view.icon ?? ''} placeholder="🙂"
            onSubmit={(value) => { ops.setIcon(view.pageId!, value); setPicker(null); }}
          />
          {view.icon ? (
            <button className="notes-popover-clear"
              onClick={() => { ops.setIcon(view.pageId!, ''); setPicker(null); }}>Remove icon</button>
          ) : null}
        </Popover>
      ) : null}

      {picker === 'cover' && view.pageId ? (
        <Popover onClose={() => setPicker(null)}>
          <TextField
            label="Cover image address" value={view.cover ?? ''} placeholder="https://…"
            onSubmit={(value) => { ops.setCover(view.pageId!, value); setPicker(null); }}
          />
          {view.cover ? (
            <button className="notes-popover-clear"
              onClick={() => { ops.setCover(view.pageId!, ''); setPicker(null); }}>Remove cover</button>
          ) : null}
        </Popover>
      ) : null}
    </header>
  );
}

/**
 * A field that commits on Enter or on the button, and not on every keystroke.
 *
 * An address typed a character at a time would write "h", "ht", "htt" into the
 * block — each one a stamped edit in the outbox (D2), each one syncing, and
 * every intermediate value a broken image on every other device.
 */
function TextField({ label, value, placeholder, onSubmit }: {
  label: string;
  value: string;
  placeholder: string;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  return (
    <div className="notes-popover-field">
      <label className="notes-popover-label">{label}</label>
      <div className="notes-popover-row">
        <input className="filter" autoFocus value={draft} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(draft.trim()); }} />
        <button className="notes-popover-ok" onClick={() => onSubmit(draft.trim())}>Set</button>
      </div>
    </div>
  );
}

/** Portaled to `<body>` so a scrolling column cannot clip it. */
function Popover({ children, onClose }: {
  children: React.ReactNode;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    // Deferred a tick: the click that OPENED the popover is still propagating,
    // and a listener added synchronously catches it and closes immediately.
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="notes-popover-scrim">
      <div className="notes-popover" ref={ref}>{children}</div>
    </div>,
    document.body,
  );
}
