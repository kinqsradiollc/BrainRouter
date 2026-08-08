/**
 * ADR-029 E3 — a database, as a block inside a page and as a page of its own.
 *
 * > **A database row IS a page.** Not a record that links to one — the same
 * > block, with properties.
 *
 * That is why there is no row store here and no row id: every gesture below is
 * `notes-database-*`, which composes the same `createBlock` / `updateBlock` the
 * editor uses. Adding a row creates a page and OPENS it, because a row that
 * cannot be opened and written in is the record E3 refuses.
 *
 * **The projection is core's.** Which rows a view shows, which bucket each falls
 * in, what each cell reads as, and which of the view's rules could not be
 * applied all arrive from `notes-database-read`. This file arranges them. The
 * five views are five layouts over one answer, so a saved filter cannot hide
 * different rows in the table and on the board.
 *
 * **Nothing with no grouping value is dropped.** Core always produces the
 * no-value bucket, and the board renders it as a column and the calendar as a
 * strip beside the grid. A row that vanished from a view is a question with no
 * answer.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons.js';
import { DatabaseCell } from './DatabaseCell.js';
import { FilterControl, GroupControl, PropertiesControl, SortControl, ViewTabs } from './DatabaseControls.js';
import { bindDatabaseOps, type DatabaseHostOps, type DatabaseOps } from './databaseOps.js';
import { RefChip } from '../components/workspace/RefChip.js';
import {
  boardColumns, calendarModel, canDragBetweenGroups, defaultCalendarAnchor, emptyViewLine,
  groupDropValue, monthLabel, rowCountLine, shiftMonth, todayKey, toggleHeaderSort, valueList,
  viewNotices, visibleProperties, WEEKDAY_LABELS,
  type DatabasePropertyDto, type DatabaseReadDto, type DatabaseRowDto,
} from '../lib/notes/database.js';

export interface DatabaseBlockProps {
  databaseId: string;
  host: DatabaseHostOps;
  /** A3 — labels resolved from the blocks, so a relation chip is never a snapshot. */
  refLabels: Record<string, string>;
  /** Bumped by the container after every write, so the projection is re-read. */
  revision: number;
  /** A full-page database owns the column; an embedded one sits in the flow. */
  full?: boolean;
}

export function DatabaseBlock({
  databaseId, host, refLabels, revision, full,
}: DatabaseBlockProps): React.ReactElement {
  const [dto, setDto] = useState<DatabaseReadDto | null>(null);
  const [viewId, setViewId] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void host.read(databaseId, viewId).then((next) => {
      if (cancelled) return;
      if (next && next.found) { setDto(next); setMissing(false); return; }
      // A projection core refused is a block that is not a database (or is
      // gone). Reported rather than rendered as an empty table, which would look
      // like a database somebody had emptied.
      setMissing(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [databaseId, viewId, revision, host]);

  const options = useCallback(
    (propertyId: string) => dto?.properties.find((p) => p.id === propertyId)?.options ?? [],
    [dto],
  );
  const ops = useMemo(
    () => bindDatabaseOps(databaseId, host, options, setViewId),
    [databaseId, host, options],
  );

  if (missing) {
    return <div className="db-block"><p className="db-empty-line">This block is not a database any more.</p></div>;
  }
  if (!dto) return <div className="db-block"><p className="db-empty-line">Reading the database…</p></div>;

  const notices = viewNotices(dto);

  return (
    <div className={`db-block${full ? ' is-full' : ''}`}>
      <div className="db-head">
        {full ? null : (
          <button className="db-title" onClick={ops.openDatabase} title="Open as a full page">
            {dto.title || 'Untitled database'} <Icon name="expand" size={10} />
          </button>
        )}
        <ViewTabs dto={dto} ops={ops} refLabels={refLabels} />
        <div className="db-tools">
          <FilterControl dto={dto} ops={ops} refLabels={refLabels} />
          <SortControl dto={dto} ops={ops} refLabels={refLabels} />
          <GroupControl dto={dto} ops={ops} refLabels={refLabels} />
          <PropertiesControl dto={dto} ops={ops} refLabels={refLabels} />
          <NewRowButton ops={ops} label="New" />
        </div>
      </div>

      {/* Core's sentences, not this file's: a rule it could not apply, a column
          this build cannot read, and how many rows the filter removed. */}
      {notices.map((line) => <p className="db-notice" key={line}>{line}</p>)}

      <DatabaseView dto={dto} ops={ops} refLabels={refLabels} />

      <div className="db-foot">
        <span className="db-count">{rowCountLine(dto)}</span>
        <NewRowButton ops={ops} label="New page" />
      </div>
    </div>
  );
}

/**
 * Adding a row.
 *
 * The created row is OPENED. E3 makes a row a page, and a surface that created
 * one and left the person looking at a table cell would have made a page nobody
 * ever sees the body of — which is exactly the "record that links to a page"
 * this decision refuses.
 */
function NewRowButton({ ops, label }: { ops: DatabaseOps; label: string }): React.ReactElement {
  return (
    <button
      className="db-new-row"
      onClick={() => void ops.addRow().then((id) => { if (id) ops.openRow(id); })}
    >
      <Icon name="plus" size={10} /> {label}
    </button>
  );
}

function DatabaseView(props: { dto: DatabaseReadDto; ops: DatabaseOps; refLabels: Record<string, string> }): React.ReactElement {
  switch (props.dto.kind) {
    case 'board': return <BoardView {...props} />;
    case 'list': return <ListView {...props} />;
    case 'calendar': return <CalendarView {...props} />;
    case 'gallery': return <GalleryView {...props} />;
    default: return <TableView {...props} />;
  }
}

/* ------------------------------------------------------------------ table */

function TableView({ dto, ops, refLabels }: {
  dto: DatabaseReadDto; ops: DatabaseOps; refLabels: Record<string, string>;
}): React.ReactElement {
  const columns = visibleProperties(dto);

  if (dto.rows.length === 0) return <p className="db-empty-line">{emptyViewLine(dto)}</p>;

  return (
    <div className="db-table-scroll">
      <table className="db-table">
        <thead>
          <tr>
            {columns.map((property) => (
              <th key={property.id}>
                {/* One click sorts, a third removes the sort — the whole rule is
                    in `toggleHeaderSort`, so the menu and the header agree. */}
                <SortableHeader dto={dto} ops={ops} property={property} />
              </th>
            ))}
            <th className="db-col-end" />
          </tr>
        </thead>
        <tbody>
          {dto.rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell) => {
                const property = columns.find((candidate) => candidate.id === cell.property);
                if (!property) return null;
                return (
                  <td key={cell.property}>
                    <DatabaseCell
                      property={property}
                      value={cell.value}
                      display={cell.display}
                      // F2 — the sentence goes in the cell, where the person
                      // reading the number is looking.
                      {...(cell.error ? { error: cell.error } : {})}
                      refLabels={refLabels}
                      searchRefs={ops.searchRefs}
                      onOpenRef={ops.openRef}
                      onWrite={(value) => void ops.setValue(row.id, cell.property, value)}
                      onAddOption={(option) => void ops.addOption(cell.property, option)}
                      onAttachFile={ops.attachFile}
                      describeFiles={ops.describeFiles}
                      onOpenRow={property.type === 'title' ? () => ops.openRow(row.id) : undefined}
                    />
                  </td>
                );
              })}
              <td className="db-col-end">
                <button
                  className="db-icon-btn" aria-label="Delete this row"
                  title="Delete this row. It goes to the trash like any other page."
                  onClick={() => void ops.removeRow(row.id)}
                >
                  <Icon name="trash" size={11} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({ dto, ops, property }: {
  dto: DatabaseReadDto; ops: DatabaseOps; property: DatabasePropertyDto;
}): React.ReactElement {
  const direction = dto.view.sort?.find((rule) => rule.property === property.id)?.direction ?? null;
  return (
    <button
      className={`db-th${property.unsupported ? ' is-unsupported' : ''}`}
      title={property.unsupported ? 'This version cannot sort by this column.' : 'Sort by this column'}
      disabled={property.unsupported}
      // The whole rule — ascending, descending, then OFF — is `toggleHeaderSort`,
      // which the sort menu reads too, so a header click and the menu cannot
      // disagree about what a third click does.
      onClick={() => void ops.saveView({
        viewId: dto.view.id, sort: toggleHeaderSort(dto.view.sort, property.id),
      })}
    >
      {property.name}
      {direction ? <span className="db-th-sort">{direction === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ board */

function BoardView({ dto, ops, refLabels }: {
  dto: DatabaseReadDto; ops: DatabaseOps; refLabels: Record<string, string>;
}): React.ReactElement {
  const columns = boardColumns(dto);
  const groupBy = dto.view.groupBy
    ? dto.properties.find((property) => property.id === dto.view.groupBy) ?? null
    : null;
  const draggable = canDragBetweenGroups(groupBy);
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <div className="db-board">
      {columns.map((column) => (
        <div
          // The no-value bucket needs a key that a real option id cannot take,
          // and prefixing the real ones is what guarantees it: an option
          // actually called "no-value" keys as `v:no-value`.
          key={column.key === null ? 'no-value' : `v:${column.key}`}
          className={`db-board-col${column.noValue ? ' is-none' : ''}`}
          onDragOver={(event) => { if (draggable && dragging) event.preventDefault(); }}
          onDrop={(event) => {
            if (!draggable || !dragging || !groupBy) return;
            event.preventDefault();
            void ops.setValue(dragging, groupBy.id, groupDropValue(groupBy, column.key));
            setDragging(null);
          }}
        >
          <header className="db-board-head">
            <span className="db-board-label">{column.label}</span>
            <span className="db-board-count">{column.rows.length}</span>
          </header>
          <div className="db-board-cards">
            {column.rows.map((row) => (
              <RowCard
                key={row.id} row={row} dto={dto} ops={ops} refLabels={refLabels}
                draggable={draggable}
                onDragStart={() => setDragging(row.id)}
                onDragEnd={() => setDragging(null)}
              />
            ))}
            {column.rows.length === 0 ? <span className="db-board-empty">Nothing here</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- list */

function ListView({ dto, ops, refLabels }: {
  dto: DatabaseReadDto; ops: DatabaseOps; refLabels: Record<string, string>;
}): React.ReactElement {
  const columns = visibleProperties(dto).filter((property) => property.type !== 'title');
  if (dto.rows.length === 0) return <p className="db-empty-line">{emptyViewLine(dto)}</p>;

  return (
    <div className="db-list">
      {dto.rows.map((row) => (
        <div className="db-list-row" key={row.id}>
          <button className="db-list-title" onClick={() => ops.openRow(row.id)}>
            <span className="db-row-icon">{row.icon ?? <Icon name="note" size={11} />}</span>
            {row.title}
          </button>
          {/* The other columns as core rendered them: a list is a reading view,
              so it shows values rather than offering editors for all of them.
              A relation is the exception — A3 says its label is resolved now,
              so it renders as the shared chip rather than as a stored URI. */}
          <span className="db-list-meta">
            {columns.map((property) => {
              const cell = row.cells.find((candidate) => candidate.property === property.id);
              if (!cell) return null;
              if (property.type === 'relation') {
                return (
                  <React.Fragment key={property.id}>
                    {valueList(cell.value).map((uri) => (
                      <RefChip key={uri} uri={uri} label={refLabels[uri]} onOpen={ops.openRef} />
                    ))}
                  </React.Fragment>
                );
              }
              return cell.display ? <span className="db-tag" key={property.id}>{cell.display}</span> : null;
            })}
          </span>
          <button className="db-icon-btn" aria-label="Delete this row" onClick={() => void ops.removeRow(row.id)}>
            <Icon name="trash" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- calendar */

function CalendarView({ dto, ops, refLabels }: {
  dto: DatabaseReadDto; ops: DatabaseOps; refLabels: Record<string, string>;
}): React.ReactElement {
  // The month on screen is local state — a saved view stores WHICH property
  // places the rows, not which month somebody last looked at, because a stored
  // month would sync and move another device's calendar under them.
  const [anchor, setAnchor] = useState(() => defaultCalendarAnchor(dto));
  const model = calendarModel(dto, anchor);
  const groupBy = dto.view.groupBy
    ? dto.properties.find((property) => property.id === dto.view.groupBy) ?? null
    : null;

  return (
    <div className="db-calendar">
      <div className="db-cal-head">
        <button className="db-icon-btn" aria-label="Previous month" onClick={() => setAnchor(shiftMonth(anchor, -1))}>
          <Icon name="chev-left" size={12} />
        </button>
        <span className="db-cal-title">{monthLabel(anchor)}</span>
        <button className="db-icon-btn" aria-label="Next month" onClick={() => setAnchor(shiftMonth(anchor, 1))}>
          <Icon name="chev-right" size={12} />
        </button>
        <button className="db-tool" onClick={() => setAnchor(`${todayKey().slice(0, 7)}-01`)}>This month</button>
        {model.offMonth > 0 ? (
          // Counted rather than absent: a row outside the month on screen has
          // not gone anywhere, and saying so is what stops someone hunting it.
          <span className="db-cal-off">
            {model.offMonth === 1 ? '1 row is in another month' : `${model.offMonth} rows are in other months`}
          </span>
        ) : null}
      </div>

      <div className="db-cal-grid">
        {WEEKDAY_LABELS.map((label) => <span key={label} className="db-cal-weekday">{label}</span>)}
        {model.weeks.flat().map((day) => (
          <div
            key={day.key}
            className={`db-cal-cell${day.inMonth ? '' : ' is-outside'}${day.key === todayKey() ? ' is-today' : ''}`}
          >
            <span className="db-cal-daynum">{day.day}</span>
            {day.rows.map((row) => (
              <button key={row.id} className="db-cal-pill" onClick={() => ops.openRow(row.id)} title={row.title}>
                {row.title}
              </button>
            ))}
            {groupBy && day.inMonth ? (
              // A day cell is where a person means "something happens then", so
              // it creates the row with that day already set.
              <button
                className="db-cal-add" aria-label={`Add a row on ${day.key}`}
                onClick={() => void ops.addRow().then((id) => {
                  if (!id) return;
                  void ops.setValue(id, groupBy.id, day.key).then(() => ops.openRow(id));
                })}
              >
                <Icon name="plus" size={9} />
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {/* E3 — the no-value bucket is rendered, never dropped. Core labels it. */}
      <div className="db-cal-side">
        <header className="db-board-head">
          <span className="db-board-label">{model.unscheduledLabel}</span>
          <span className="db-board-count">{model.unscheduled.length}</span>
        </header>
        <div className="db-board-cards">
          {model.unscheduled.map((row) => (
            <RowCard key={row.id} row={row} dto={dto} ops={ops} refLabels={refLabels} draggable={false} />
          ))}
          {model.unscheduled.length === 0 ? <span className="db-board-empty">Nothing undated</span> : null}
        </div>
      </div>

      {model.unplaced.map((bucket) => (
        <div className="db-cal-side" key={bucket.label}>
          <header className="db-board-head">
            <span className="db-board-label">{bucket.label}</span>
            <span className="db-board-count">{bucket.rows.length}</span>
          </header>
          <div className="db-board-cards">
            {bucket.rows.map((row) => (
              <RowCard key={row.id} row={row} dto={dto} ops={ops} refLabels={refLabels} draggable={false} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- gallery */

function GalleryView({ dto, ops, refLabels }: {
  dto: DatabaseReadDto; ops: DatabaseOps; refLabels: Record<string, string>;
}): React.ReactElement {
  if (dto.rows.length === 0) return <p className="db-empty-line">{emptyViewLine(dto)}</p>;
  return (
    <div className="db-gallery">
      {dto.rows.map((row) => (
        <div className="db-gallery-card" key={row.id}>
          {/* A page's cover is a page field (E4), and a row is a page — so a
              gallery is the cover the person already set, not a second image. */}
          <button
            className="db-gallery-cover"
            style={row.cover ? { backgroundImage: `url("${row.cover.replace(/"/g, '%22')}")` } : undefined}
            onClick={() => ops.openRow(row.id)}
          >
            {row.cover ? null : <span className="db-gallery-glyph">{row.icon ?? '□'}</span>}
          </button>
          <RowCard row={row} dto={dto} ops={ops} refLabels={refLabels} draggable={false} bare />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- card */

/**
 * A row as a card — the title, then its visible cells, each still editable.
 *
 * Editable on the board and in the gallery rather than read-only, because the
 * gesture people repeat on a board is changing one field, and a card that had to
 * be opened first would make the board a navigation surface instead of a working
 * one.
 */
function RowCard({ row, dto, ops, refLabels, draggable, onDragStart, onDragEnd, bare }: {
  row: DatabaseRowDto;
  dto: DatabaseReadDto;
  ops: DatabaseOps;
  refLabels: Record<string, string>;
  draggable: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  bare?: boolean;
}): React.ReactElement {
  const columns = visibleProperties(dto);
  return (
    <div
      className={`db-card${bare ? ' is-bare' : ''}${draggable ? ' is-draggable' : ''}`}
      draggable={draggable}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; onDragStart?.(); }}
      onDragEnd={onDragEnd}
    >
      <button className="db-card-title" onClick={() => ops.openRow(row.id)}>
        <span className="db-row-icon">{row.icon ?? <Icon name="note" size={11} />}</span>
        {row.title}
      </button>
      {columns.filter((property) => property.type !== 'title').map((property) => {
        const cell = row.cells.find((candidate) => candidate.property === property.id);
        if (!cell) return null;
        return (
          <div className="db-card-field" key={property.id}>
            <span className="db-card-label">{property.name}</span>
            <DatabaseCell
              property={property}
              value={cell.value}
              display={cell.display}
              {...(cell.error ? { error: cell.error } : {})}
              refLabels={refLabels}
              searchRefs={ops.searchRefs}
              onOpenRef={ops.openRef}
              onWrite={(value) => void ops.setValue(row.id, property.id, value)}
              onAddOption={(option) => void ops.addOption(property.id, option)}
              onAttachFile={ops.attachFile}
              describeFiles={ops.describeFiles}
              variant="field"
            />
          </div>
        );
      })}
    </div>
  );
}
