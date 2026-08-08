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
 *
 * The icon picker itself moved to `IconPicker.tsx` when Part F gave a callout
 * one: `NoteBlock.icon` is a single field for both, so a second picker would be
 * two palettes writing one value.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import { IconPicker, Popover, TextField } from './IconPicker.js';
import {
  coverActionLabel, coverStyle, favouriteActionLabel, iconActionLabel, newPageLabel,
  PAGE_TITLE_PLACEHOLDER, titleFieldValue, type PageHeaderView,
} from '../lib/notes/pageHeader.js';
import { exportChoicesFor, type NoteExportFormatId } from '../lib/notes/exportView.js';
import { TOP_LEVEL_LABEL } from '../lib/notes/pageTree.js';

export interface PageHeaderOps {
  openPage: (pageId: string | null) => void;
  setPageTitle: (id: string, title: string) => void;
  setIcon: (id: string, icon: string) => void;
  setCover: (id: string, cover: string) => void;
  setFavourite: (id: string, favourite: boolean) => void;
  addPage: (parentId: string | null) => void;
  /**
   * F3 — "can I leave", as a control on the page it is about.
   *
   * Here rather than in a settings screen because that is the question's shape:
   * somebody wants THIS page out, and a global "export everything" is a
   * different feature that answers a different worry.
   */
  exportPage: (blockId: string, format: NoteExportFormatId) => void;
}

export function PageHeader({
  view, block, ops,
}: {
  view: PageHeaderView;
  /** The page block itself, for the title field. Absent at the top level. */
  block: { text: string } | null;
  ops: PageHeaderOps;
}): React.ReactElement {
  const [picker, setPicker] = useState<'icon' | 'cover' | 'export' | null>(null);
  const cover = coverStyle(view.cover);
  const exports = exportChoicesFor(view.database);

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
        {/* E3 — a database's children are ROWS, and the way to make one is the
            database's own control, which also opens the page it created. A
            "new page inside" here would leave a blank row nobody navigated to. */}
        {view.database ? null : (
          <button className="notes-page-tool" onClick={() => ops.addPage(view.pageId)}>
            <Icon name="plus" size={11} /> {newPageLabel(view.editable ? view.title : null)}
          </button>
        )}
        {/* F3 — the top level is not a block, so there is nothing to write out;
            every real page is. A control that was always there and sometimes
            did nothing is the defect F1 is about, in a header. */}
        {view.pageId ? (
          <button className="notes-page-tool" onClick={() => setPicker(picker === 'export' ? null : 'export')}>
            <Icon name="export" size={11} /> Export
          </button>
        ) : null}
      </div>

      {picker === 'export' && view.pageId ? (
        <Popover onClose={() => setPicker(null)}>
          {exports.map((choice) => (
            <button
              key={choice.format}
              className="notes-popover-item"
              onClick={() => { ops.exportPage(view.pageId!, choice.format); setPicker(null); }}
            >
              {choice.label}
            </button>
          ))}
        </Popover>
      ) : null}

      {picker === 'icon' && view.pageId ? (
        <IconPicker
          current={view.icon}
          onPick={(glyph) => { ops.setIcon(view.pageId!, glyph); setPicker(null); }}
          onClear={() => { ops.setIcon(view.pageId!, ''); setPicker(null); }}
          onClose={() => setPicker(null)}
        />
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
